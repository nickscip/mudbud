"""Every branch of the connection module that does not need a live Postgres.

`test_referenced_shas.py` proves the SQL against a real database and skips without
`TEST_SUPABASE_DB_URL`. These cover the same module's Python: the pooler-safe connect
kwargs, the advisory-lock lifecycle, and which query failures are swallowed versus
propagated — with `Mock` connections, so they run everywhere.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import cast
from unittest.mock import Mock

import psycopg
import pytest

import glaze_etl.core.db as db

DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def _conn() -> Mock:
    """A connection whose `execute()` returns a cursor, like psycopg's does."""
    return Mock()


def test_connect_disables_prepared_statements(monkeypatch: pytest.MonkeyPatch) -> None:
    """The whole reason this module exists: pgbouncer transaction pooling."""
    psycopg_connect = Mock()
    monkeypatch.setattr(db.psycopg, "connect", psycopg_connect)

    assert db.connect(DSN) is psycopg_connect.return_value

    psycopg_connect.assert_called_once_with(DSN, autocommit=False, prepare_threshold=None)


def test_connect_threads_autocommit_through(monkeypatch: pytest.MonkeyPatch) -> None:
    psycopg_connect = Mock()
    monkeypatch.setattr(db.psycopg, "connect", psycopg_connect)

    db.connect(DSN, autocommit=True)

    assert psycopg_connect.call_args.kwargs["autocommit"] is True
    assert psycopg_connect.call_args.kwargs["prepare_threshold"] is None


def test_connection_closes_the_connection_on_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = _conn()
    monkeypatch.setattr(db, "connect", Mock(return_value=conn))

    with db.connection(DSN, autocommit=True) as opened:
        assert opened is conn
        conn.close.assert_not_called()

    conn.close.assert_called_once_with()


def test_connection_closes_the_connection_when_the_body_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _conn()
    monkeypatch.setattr(db, "connect", Mock(return_value=conn))

    with pytest.raises(ZeroDivisionError), db.connection(DSN):
        raise ZeroDivisionError("the caller blew up mid-transaction")

    conn.close.assert_called_once_with()


def test_blob_operation_lock_id_is_stable_per_manufacturer() -> None:
    amaco = db._blob_operation_lock_id("amaco")

    assert amaco == db._blob_operation_lock_id("amaco")
    assert amaco != db._blob_operation_lock_id("mayco")
    # Postgres's one-argument advisory-lock namespace is a signed bigint.
    assert -(2**63) <= amaco < 2**63
    assert -(2**63) <= db._blob_operation_lock_id("mayco") < 2**63


def test_check_passes_while_the_connection_answers() -> None:
    conn = _conn()
    lock = db.BlobOperationLock(cast(db.Connection, conn))

    lock.check()

    conn.execute.assert_called_once_with("select 1")


def test_check_remembers_a_failure_instead_of_re_pinging() -> None:
    conn = _conn()
    conn.execute.side_effect = psycopg.OperationalError("connection dropped")
    lock = db.BlobOperationLock(cast(db.Connection, conn))

    with pytest.raises(db.BlobOperationLockLost, match="connection failed"):
        lock.check()
    with pytest.raises(db.BlobOperationLockLost, match="heartbeat failed"):
        lock.check()

    assert conn.execute.call_count == 1, "a lost lock pinged a connection it knows is dead"


def test_a_heartbeat_failure_surfaces_from_the_next_check() -> None:
    conn = _conn()
    conn.execute.side_effect = psycopg.OperationalError("the pooler evicted the backend")
    lock = db.BlobOperationLock(cast(db.Connection, conn), heartbeat_seconds=0.01)
    lock.start()
    try:
        deadline = time.monotonic() + 2.0
        while lock._lost is None and time.monotonic() < deadline:
            time.sleep(0.005)
        assert lock._lost is not None, "the heartbeat never recorded the dead connection"

        with pytest.raises(db.BlobOperationLockLost, match="heartbeat"):
            lock.check()
    finally:
        lock.close()

    conn.close.assert_called_once_with()


def test_close_joins_the_heartbeat_and_tolerates_a_rollback_error() -> None:
    conn = _conn()
    conn.rollback.side_effect = psycopg.OperationalError("already disconnected")
    # Long enough that no ping happens: `close()` sets the stop event before joining.
    lock = db.BlobOperationLock(cast(db.Connection, conn), heartbeat_seconds=30.0)
    lock.start()

    lock.close()

    assert not lock._thread.is_alive()
    conn.rollback.assert_called_once_with()
    conn.close.assert_called_once_with()


def _lock_conn(row: tuple[object, ...] | None) -> Mock:
    conn = _conn()
    conn.execute.return_value.fetchone.return_value = row
    return conn


@pytest.mark.parametrize(
    ("row", "why"),
    [((False,), "another run holds the lock"), (None, "the probe returned no row")],
)
def test_exclusive_blob_operation_refuses(
    row: tuple[object, ...] | None, why: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    conn = _lock_conn(row)
    connect = Mock(return_value=conn)
    monkeypatch.setattr(db, "connect", connect)

    with (
        pytest.raises(db.BlobOperationAlreadyRunning, match="amaco"),
        db.exclusive_blob_operation(DSN, "amaco"),
    ):
        pytest.fail(f"the lock was handed out when {why}")

    connect.assert_called_once_with(DSN)
    conn.rollback.assert_called_once_with()
    conn.close.assert_called_once_with()


def test_exclusive_blob_operation_yields_a_started_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = _lock_conn((True,))
    monkeypatch.setattr(db, "connect", Mock(return_value=conn))

    with db.exclusive_blob_operation(DSN, "amaco", heartbeat_seconds=30.0) as lock:
        assert isinstance(lock, db.BlobOperationLock)
        assert lock._thread.is_alive(), "the heartbeat was never started"
        conn.close.assert_not_called()

    statements = [call.args[0] for call in conn.execute.call_args_list]
    assert "set local idle_in_transaction_session_timeout = 0" in statements
    assert any("pg_try_advisory_xact_lock" in statement for statement in statements)
    assert not lock._thread.is_alive()
    conn.rollback.assert_called_once_with()
    conn.close.assert_called_once_with()


def test_stored_object_keys_returns_the_names() -> None:
    conn = _conn()
    conn.execute.return_value.fetchall.return_value = [("a/1.jpg",), ("a/2.jpg",)]

    assert db.stored_object_keys(cast(db.Connection, conn), "mudbud_amaco") == {
        "a/1.jpg",
        "a/2.jpg",
    }
    assert conn.execute.call_args.args[1] == ("mudbud_amaco",)


def test_stored_object_keys_treats_a_missing_storage_schema_as_empty() -> None:
    """Plain Postgres has no `storage.objects`; an upload check must not hard-fail on it."""
    conn = _conn()
    conn.execute.side_effect = psycopg.ProgrammingError('relation "storage.objects" does not exist')

    assert db.stored_object_keys(cast(db.Connection, conn), "mudbud_amaco") == set()

    conn.rollback.assert_called_once_with()


def test_stored_object_ages_maps_names_to_datetimes() -> None:
    created = datetime(2026, 7, 26, tzinfo=UTC)
    conn = _conn()
    conn.execute.return_value.fetchall.return_value = [
        ("a/1.jpg", created),
        ("a/2.jpg", None),
        ("a/3.jpg", "2026-07-26T00:00:00Z"),
    ]

    ages = db.stored_object_ages(cast(db.Connection, conn), "mudbud_amaco")

    # A non-datetime age is "unknown", never "old enough to delete".
    assert ages == {"a/1.jpg": created, "a/2.jpg": None, "a/3.jpg": None}


def test_stored_object_ages_propagates_query_errors() -> None:
    """Unlike `stored_object_keys`: an unreadable bucket is not an empty bucket."""
    conn = _conn()
    conn.execute.side_effect = psycopg.ProgrammingError("storage.objects is unreadable")

    with pytest.raises(psycopg.ProgrammingError):
        db.stored_object_ages(cast(db.Connection, conn), "mudbud_amaco")

    conn.rollback.assert_not_called()


def test_referenced_shas_returns_the_shas_from_the_rows() -> None:
    conn = _conn()
    conn.execute.return_value.fetchall.return_value = [("aa",), ("bb",), ("aa",)]

    assert db.referenced_shas(cast(db.Connection, conn), "amaco") == {"aa", "bb"}
    assert conn.execute.call_args.args[1] == ("amaco",)

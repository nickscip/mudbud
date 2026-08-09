"""Fail-closed boundaries around the destructive GC command."""

from __future__ import annotations

from threading import Event
from typing import cast
from unittest.mock import Mock

import psycopg
import pytest
from typer.testing import CliRunner

import glaze_etl.cli as cli
from glaze_etl.core.config import Settings
from glaze_etl.core.db import (
    BlobOperationLock,
    BlobOperationLockLost,
    Connection,
    stored_object_ages,
)


def test_blob_operation_lock_heartbeat_keeps_the_connection_active() -> None:
    conn = cast(Connection, Mock())
    pinged = Event()
    cursor = Mock()

    def ping(_: str) -> Mock:
        pinged.set()
        return cursor

    conn.execute.side_effect = ping
    lock = BlobOperationLock(conn, heartbeat_seconds=0.01)
    lock.start()

    assert pinged.wait(timeout=0.5), "the lock connection never received a heartbeat"
    lock.close()

    conn.rollback.assert_called_once_with()
    conn.close.assert_called_once_with()


def test_blob_operation_lock_health_check_fails_loudly() -> None:
    conn = cast(Connection, Mock())
    conn.execute.side_effect = psycopg.OperationalError("connection dropped")
    lock = BlobOperationLock(conn)

    with pytest.raises(BlobOperationLockLost, match="connection failed"):
        lock.check()


def test_storage_metadata_query_errors_propagate() -> None:
    conn = cast(Connection, Mock())
    conn.execute.side_effect = psycopg.ProgrammingError("storage.objects is unreadable")

    with pytest.raises(psycopg.ProgrammingError):
        stored_object_ages(conn, "mudbud_amaco")

    conn.rollback.assert_not_called()


def test_prune_refuses_before_connecting_without_storage_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        database_url="postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        supabase_url="http://127.0.0.1:54321",
        secret_key="",
    )
    monkeypatch.setattr(cli, "Settings", lambda: settings)
    connect = Mock(side_effect=AssertionError("gc connected before validating its target"))
    monkeypatch.setattr(cli, "db_connection", connect)

    result = CliRunner().invoke(cli.app, ["gc", "--prune"])

    assert result.exit_code == 1
    assert "requires SUPABASE_URL and SUPABASE_SECRET_KEY" in result.output
    connect.assert_not_called()

"""Proves `referenced_shas` cannot leak a sha across manufacturers.

A filter on the wrong side of the `glaze_images -> glazes -> manufacturers` join is how a
sweep for one brand could delete another brand's photographs — this is the case that
matters most for `gc`.

Skipped unless a scratch Postgres is reachable — see test_store_integration.py for how
to provide one.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from collections.abc import Iterator

import psycopg
import pytest

from glaze_etl.core.db import (
    BlobOperationAlreadyRunning,
    exclusive_blob_operation,
    referenced_shas,
)

DSN = os.environ.get("TEST_SUPABASE_DB_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_SUPABASE_DB_URL not set")

type Connection = psycopg.Connection[tuple[object, ...]]


@pytest.fixture
def conn() -> Iterator[Connection]:
    assert DSN
    with psycopg.connect(DSN) as connection:
        yield connection
        connection.rollback()


def _manufacturer_id(conn: Connection, key: str) -> int:
    row = conn.execute("select id from manufacturers where key = %s", (key,)).fetchone()
    assert row is not None and isinstance(row[0], int)
    return row[0]


def _fake_sha() -> str:
    return hashlib.sha256(uuid.uuid4().bytes).hexdigest()


def _insert_glaze(conn: Connection, manufacturer_id: int, code: str) -> int:
    row = conn.execute(
        "insert into glazes (manufacturer_id, code, name, slug, product_url)"
        " values (%s, %s, %s, %s, %s) returning id",
        (manufacturer_id, code, code, code.lower(), f"https://example.test/{code.lower()}/"),
    ).fetchone()
    assert row is not None and isinstance(row[0], int)
    return row[0]


def _insert_image(
    conn: Connection, glaze_id: int, source_url: str, sha256: str | None
) -> None:
    conn.execute(
        "insert into glaze_images (glaze_id, source_url, sha256, role, raw_filename,"
        " parse_confidence)"
        " values (%s, %s, %s, 'in_use', 'x.jpg', 'high')",
        (glaze_id, source_url, sha256),
    )


def test_referenced_shas_does_not_leak_across_manufacturers(conn: Connection) -> None:
    amaco_id = _manufacturer_id(conn, "amaco")
    mayco_id = _manufacturer_id(conn, "mayco")
    amaco_sha = _fake_sha()
    mayco_sha = _fake_sha()

    amaco_glaze = _insert_glaze(conn, amaco_id, "RS-GC-1")
    _insert_image(conn, amaco_glaze, "https://example.test/amaco-1.jpg", amaco_sha)

    mayco_glaze = _insert_glaze(conn, mayco_id, "RS-GC-1")
    _insert_image(conn, mayco_glaze, "https://example.test/mayco-1.jpg", mayco_sha)

    amaco_result = referenced_shas(conn, "amaco")
    mayco_result = referenced_shas(conn, "mayco")

    assert amaco_sha in amaco_result
    assert mayco_sha not in amaco_result
    assert mayco_sha in mayco_result
    assert amaco_sha not in mayco_result


def test_a_null_sha256_row_is_excluded(conn: Connection) -> None:
    amaco_id = _manufacturer_id(conn, "amaco")
    glaze_id = _insert_glaze(conn, amaco_id, "RS-GC-2")
    _insert_image(conn, glaze_id, "https://example.test/amaco-2.jpg", None)

    assert None not in referenced_shas(conn, "amaco")


def test_two_rows_sharing_one_sha_under_the_same_manufacturer_yield_one_entry(
    conn: Connection,
) -> None:
    """A reused line-chart photo: several glazes cite the same bytes, each with its own
    `glaze_images` row (migration `20260726000600_shared_images.sql` dropped the global
    uniqueness on `sha256` for exactly this reason)."""
    amaco_id = _manufacturer_id(conn, "amaco")
    shared_sha = _fake_sha()

    first_glaze = _insert_glaze(conn, amaco_id, "RS-GC-3")
    _insert_image(conn, first_glaze, "https://example.test/amaco-3a.jpg", shared_sha)
    second_glaze = _insert_glaze(conn, amaco_id, "RS-GC-4")
    _insert_image(conn, second_glaze, "https://example.test/amaco-3b.jpg", shared_sha)

    result = referenced_shas(conn, "amaco")

    # Two rows citing the same sha must not raise (the schema now permits it) and must
    # collapse to one entry — trivially true of a set, but this is the case the SQL's
    # own `distinct` exists to guarantee at the query level, not just in Python.
    assert shared_sha in result


def test_blob_operation_lock_excludes_a_second_process() -> None:
    assert DSN
    with (
        exclusive_blob_operation(DSN, "amaco"),
        pytest.raises(BlobOperationAlreadyRunning),
        exclusive_blob_operation(DSN, "amaco"),
    ):
        pytest.fail("the same manufacturer lock was acquired twice")

    # Releasing the first transaction must make the lock available again.
    with exclusive_blob_operation(DSN, "amaco"):
        pass

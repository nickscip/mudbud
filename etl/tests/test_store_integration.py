"""Proves PostgresSnapshotStore and InMemorySnapshotStore behave identically.

InMemorySnapshotStore claims to mirror the SQL semantics, and every Fetcher test relies
on that claim. These run the same assertions against both, so the claim is checked
rather than asserted in a docstring.

Skipped unless a scratch Postgres is reachable. To provide one:

    docker run -d --rm --name mudbud-pgcheck -e POSTGRES_PASSWORD=x \
        -p 55433:5432 postgres:16-alpine
    for f in ../supabase/migrations/*.sql; do
      docker exec -i mudbud-pgcheck psql -U postgres -v ON_ERROR_STOP=1 -q < "$f"; done
    TEST_SUPABASE_DB_URL=postgresql://postgres:x@127.0.0.1:55433/postgres uv run pytest
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest

from glaze_etl.core.models import ManufacturerKey, RawSnapshot
from glaze_etl.core.store import (
    InMemorySnapshotStore,
    PostgresSnapshotStore,
    SnapshotStore,
)

DSN = os.environ.get("TEST_SUPABASE_DB_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_SUPABASE_DB_URL not set")

URL = "https://shop.amaco.com/pc-20-blue-rutile/"
BASE = datetime(2026, 7, 26, 12, 0, tzinfo=UTC)


def snap(version: int, *, etag: str | None = None) -> RawSnapshot:
    body = f"<html>v{version}</html>"
    return RawSnapshot(
        url=URL,
        fetched_at=BASE + timedelta(minutes=version),
        http_status=200,
        body=body,
        content_hash=f"hash-{version}",
        etag=etag,
    )


@pytest.fixture
def pg_store() -> Iterator[PostgresSnapshotStore]:
    import psycopg

    assert DSN
    with psycopg.connect(DSN) as conn:
        conn.execute("delete from raw_snapshots where url = %s", (URL,))
        conn.commit()
        yield PostgresSnapshotStore(conn)
        conn.rollback()


@pytest.fixture(params=["memory", "postgres"])
def store(request: pytest.FixtureRequest, pg_store: PostgresSnapshotStore) -> SnapshotStore:
    return InMemorySnapshotStore() if request.param == "memory" else pg_store


class TestEquivalence:
    def test_head_of_empty_store_is_none(self, store: SnapshotStore) -> None:
        assert store.head(URL) is None

    def test_head_returns_the_newest_row(self, store: SnapshotStore) -> None:
        store.insert(ManufacturerKey.AMACO, snap(1, etag='W/"one"'))
        store.insert(ManufacturerKey.AMACO, snap(3, etag='W/"three"'))
        store.insert(ManufacturerKey.AMACO, snap(2, etag='W/"two"'))

        head = store.head(URL)

        assert head is not None
        assert head.content_hash == "hash-3"
        assert head.etag == 'W/"three"'

    def test_head_is_scoped_to_the_url(self, store: SnapshotStore) -> None:
        store.insert(ManufacturerKey.AMACO, snap(1))
        assert store.head("https://shop.amaco.com/pc-30-temmoku/") is None

    def test_prune_keeps_the_newest_n_and_reports_the_count(self, store: SnapshotStore) -> None:
        for version in range(1, 6):
            store.insert(ManufacturerKey.AMACO, snap(version))

        removed = store.prune(URL, keep=2)

        assert removed == 3
        head = store.head(URL)
        assert head is not None and head.content_hash == "hash-5"

    def test_prune_is_a_noop_below_the_threshold(self, store: SnapshotStore) -> None:
        store.insert(ManufacturerKey.AMACO, snap(1))
        assert store.prune(URL, keep=3) == 0

    def test_null_etag_round_trips(self, store: SnapshotStore) -> None:
        store.insert(ManufacturerKey.AMACO, snap(1, etag=None))
        head = store.head(URL)
        assert head is not None and head.etag is None

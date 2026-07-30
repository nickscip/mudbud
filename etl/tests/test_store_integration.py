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

import psycopg
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


def snap(version: int, *, etag: str | None = None, url: str = URL) -> RawSnapshot:
    body = f"<html>v{version}</html>"
    return RawSnapshot(
        url=url,
        fetched_at=BASE + timedelta(minutes=version),
        http_status=200,
        body=body,
        content_hash=f"hash-{version}",
        etag=etag,
    )


@pytest.fixture
def pg_conn() -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    assert DSN
    with psycopg.connect(DSN) as conn:
        conn.execute("delete from raw_snapshots where url = %s", (URL,))
        conn.commit()
        yield conn
        conn.rollback()


@pytest.fixture
def pg_store(pg_conn: psycopg.Connection[tuple[object, ...]]) -> PostgresSnapshotStore:
    return PostgresSnapshotStore(pg_conn)


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


class TestReadBack:
    """The replay side, used by `load`, `reparse` and the ingest activity.

    Postgres-only: these are not on the `SnapshotStore` Protocol, because the Fetcher
    never replays and should not carry the dependency.
    """

    OTHER = "https://shop.amaco.com/pc-30-temmoku/"

    @pytest.fixture(autouse=True)
    def _clean_other_url(self, pg_conn: psycopg.Connection[tuple[object, ...]]) -> None:
        pg_conn.execute("delete from raw_snapshots where url = %s", (self.OTHER,))
        pg_conn.commit()

    def test_newest_returns_the_latest_body_for_a_url(
        self, pg_store: PostgresSnapshotStore
    ) -> None:
        pg_store.insert(ManufacturerKey.AMACO, snap(1))
        pg_store.insert(ManufacturerKey.AMACO, snap(3))
        pg_store.insert(ManufacturerKey.AMACO, snap(2))

        snapshot = pg_store.newest(URL, ManufacturerKey.AMACO)

        assert snapshot is not None
        assert snapshot.body == "<html>v3</html>"
        assert snapshot.content_hash == "hash-3"
        assert str(snapshot.url) == URL

    def test_newest_is_none_when_the_source_never_stored_it(
        self, pg_store: PostgresSnapshotStore
    ) -> None:
        assert pg_store.newest(URL, ManufacturerKey.AMACO) is None

    def test_newest_per_url_keeps_one_row_per_url(
        self, pg_store: PostgresSnapshotStore
    ) -> None:
        pg_store.insert(ManufacturerKey.AMACO, snap(1))
        pg_store.insert(ManufacturerKey.AMACO, snap(2))
        pg_store.insert(ManufacturerKey.AMACO, snap(1, url=self.OTHER))

        got = {str(s.url): s.content_hash for s in pg_store.newest_per_url(ManufacturerKey.AMACO)}

        assert got[URL] == "hash-2", "older rows are history, not current truth"
        assert got[self.OTHER] == "hash-1"

    def test_newest_per_url_narrows_to_the_urls_asked_for(
        self, pg_store: PostgresSnapshotStore
    ) -> None:
        pg_store.insert(ManufacturerKey.AMACO, snap(1))
        pg_store.insert(ManufacturerKey.AMACO, snap(1, url=self.OTHER))

        got = pg_store.newest_per_url(ManufacturerKey.AMACO, [URL])

        assert [str(s.url) for s in got] == [URL]

    def test_an_empty_url_list_means_none_rather_than_everything(
        self, pg_store: PostgresSnapshotStore
    ) -> None:
        """`[]` is a caller asking for nothing; only `None` means the whole corpus."""
        pg_store.insert(ManufacturerKey.AMACO, snap(1))
        assert pg_store.newest_per_url(ManufacturerKey.AMACO, []) == []

    def test_another_sources_snapshot_is_invisible(
        self, pg_store: PostgresSnapshotStore, pg_conn: psycopg.Connection[tuple[object, ...]]
    ) -> None:
        """The drift these methods exist to remove: a page stored by one source must not
        be handed to another source's parser just because the URL matches.

        Written by inserting the foreign row directly, since `ManufacturerKey` has only
        one member today — the collision is reachable in SQL before it is in Python.
        """
        pg_conn.execute(
            "insert into manufacturers (key, name, site_url)"
            " values ('testco', 'Test Co', 'https://example.test')"
        )
        pg_conn.execute(
            """
            insert into raw_snapshots
              (manufacturer_id, url, fetched_at, http_status, content_hash, body)
            select m.id, %s, %s, 200, 'hash-foreign', '<html>not ours</html>'
            from manufacturers m where m.key = 'testco'
            """,
            (URL, BASE + timedelta(hours=1)),
        )

        assert pg_store.newest_per_url(ManufacturerKey.AMACO) == []
        assert pg_store.newest(URL, ManufacturerKey.AMACO) is None

"""The catalog is evergreen: a product the manufacturer stops listing stays, marked.

Two halves. `listing_is_complete` is the pure guard that keeps a broken sitemap from marking
most of a catalog unavailable; `Loader.reconcile_listing` is the SQL, run against a scratch
Postgres (see test_store_integration.py for how to provide one) because its whole job is a
manufacturer-scoped `update`, and the scoping is what a unit test could not prove.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest

from glaze_etl.core.loader import UNAVAILABLE, Loader, listing_is_complete


class TestListingIsComplete:
    def test_nothing_known_means_nothing_to_protect(self) -> None:
        assert listing_is_complete(0, 0)
        assert listing_is_complete(12, 0)

    def test_half_or_more_is_believed(self) -> None:
        assert listing_is_complete(352, 352)
        assert listing_is_complete(176, 352)
        assert listing_is_complete(400, 352)

    def test_fewer_than_half_is_a_broken_listing(self) -> None:
        assert not listing_is_complete(175, 352)
        assert not listing_is_complete(0, 352)
        assert not listing_is_complete(3, 630)


DSN = os.environ.get("TEST_SUPABASE_DB_URL")

type Connection = psycopg.Connection[tuple[object, ...]]


@pytest.fixture
def conn() -> Iterator[Connection]:
    assert DSN
    with psycopg.connect(DSN) as connection:
        yield connection
        connection.rollback()


def _seed(conn: Connection, manufacturer: str, code: str, availability: str | None) -> None:
    conn.execute(
        """
        insert into glazes (manufacturer_id, code, name, slug, product_url, availability,
                            last_seen_at)
        select m.id, %s, %s, %s, %s, %s, now() - interval '30 days'
        from manufacturers m where m.key = %s
        """,
        (
            code,
            code,
            code.lower(),
            f"https://example.test/{code.lower()}/",
            availability,
            manufacturer,
        ),
    )


def _state(conn: Connection, manufacturer: str) -> dict[str, tuple[str | None, bool]]:
    """code -> (availability, last_seen_at bumped within the last minute)."""
    rows = conn.execute(
        """
        select g.code, g.availability, g.last_seen_at > now() - interval '1 minute'
        from glazes g join manufacturers m on m.id = g.manufacturer_id
        where m.key = %s
        """,
        (manufacturer,),
    ).fetchall()
    return {str(code): (avail, bool(recent)) for code, avail, recent in rows}  # type: ignore[misc]


@pytest.mark.skipif(not DSN, reason="TEST_SUPABASE_DB_URL not set")
class TestReconcileListing:
    def test_unlisted_is_marked_and_listed_is_stamped(self, conn: Connection) -> None:
        _seed(conn, "amaco", "T-1", "InStock")
        _seed(conn, "amaco", "T-2", "OutOfStock")
        loader = Loader(conn, normalizer=None)  # type: ignore[arg-type]

        seen, marked = loader.reconcile_listing("amaco", ["t-1"])

        assert seen == 1
        assert marked == ["T-2"]
        state = _state(conn, "amaco")
        assert state["T-1"] == ("InStock", True)
        assert state["T-2"] == (UNAVAILABLE, False)

    def test_nothing_is_deleted_and_marking_is_idempotent(self, conn: Connection) -> None:
        _seed(conn, "amaco", "T-1", "InStock")
        _seed(conn, "amaco", "T-2", None)
        loader = Loader(conn, normalizer=None)  # type: ignore[arg-type]

        loader.reconcile_listing("amaco", ["t-1"])
        seen, marked = loader.reconcile_listing("amaco", ["t-1"])

        assert seen == 1
        assert marked == []  # already marked, so not reported twice
        assert set(_state(conn, "amaco")) >= {"T-1", "T-2"}

    def test_scoped_to_the_manufacturer_asked_about(self, conn: Connection) -> None:
        """The failure that matters: a full AMACO listing says nothing about Mayco."""
        _seed(conn, "amaco", "T-1", "InStock")
        _seed(conn, "mayco", "T-9", "InStock")
        loader = Loader(conn, normalizer=None)  # type: ignore[arg-type]

        _, marked = loader.reconcile_listing("amaco", ["t-1"])

        assert marked == []
        assert _state(conn, "mayco")["T-9"] == ("InStock", False)

    def test_glaze_count_is_scoped_too(self, conn: Connection) -> None:
        _seed(conn, "amaco", "T-1", "InStock")
        _seed(conn, "mayco", "T-9", "InStock")
        loader = Loader(conn, normalizer=None)  # type: ignore[arg-type]

        assert loader.glaze_count("amaco") == 1
        assert loader.glaze_count("mayco") == 1

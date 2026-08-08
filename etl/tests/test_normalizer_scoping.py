"""Proves a vocabulary lookup cannot reach another manufacturer's rows (roadmap F8, F8a).

`clay_bodies` has been scoped by manufacturer since the first migration and `coat_levels`
became so in `20260807000100`, but the *lookup* read both tables flat — every brand's rows
into one code-to-id dict. That resolved correctly only because the seeded keys happened not
to collide: AMACO spells its coat levels in thickness words and Mayco in brush-coat digits.
An accident of the data is not a guard, and the failure it was hiding is silent — a wrong
`smallint` in a foreign key column, indistinguishable from a right one at any row count.

Two of these tests need no database. `load_vocabularies` only calls `.execute(...).fetchall()`,
so the branches that do not depend on real rows — an unseeded manufacturer, an adapter whose
declared coat order the vocabulary does not publish — are cheaper and more precise to pin with
a stub than to skip whenever Postgres is absent.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest

from glaze_etl.core.models import ManufacturerKey
from glaze_etl.core.normalizer import load_vocabularies
from glaze_etl.core.pipeline import normalizer_for
from glaze_etl.sources import adapter_for

DSN = os.environ.get("TEST_SUPABASE_DB_URL")
needs_db = pytest.mark.skipif(not DSN, reason="TEST_SUPABASE_DB_URL not set")

type Connection = psycopg.Connection[tuple[object, ...]]

FULL_AMACO_COATS = [("light", 1), ("slightly_light", 2), ("slightly_heavy", 3), ("heavy", 4)]


class _StubResult:
    def __init__(self, rows: list[tuple[str, int]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[str, int]]:
        return self._rows


class _StubConn:
    """Answers `load_vocabularies`'s queries out of a dict, keyed by table name.

    Matching on the table is enough because that is the whole query surface of the module
    under test: seven `select <key>, id from <table>` reads, two of them with a `where`.
    """

    def __init__(self, tables: dict[str, list[tuple[str, int]]]) -> None:
        self._tables = tables

    def execute(self, sql: str, params: tuple[object, ...] = ()) -> _StubResult:
        table = sql.split(" from ")[1].split()[0]
        return _StubResult(self._tables.get(table, []))


def test_a_manufacturer_with_no_row_is_a_lookup_error() -> None:
    """The state a half-landed source is in: the enum member exists, the seed migration
    has not been applied yet. F10 passed through exactly this interval. Stopping is the
    only safe answer — every scoped lookup would otherwise miss and write nulls."""
    conn = _StubConn({"manufacturers": [("amaco", 1)]})

    with pytest.raises(LookupError, match="mayco"):
        load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)


def test_startup_refuses_an_adapter_whose_coat_levels_are_not_published() -> None:
    """The check that makes the scoping self-reporting.

    A vocabulary scoped to the wrong owner comes back empty, and the composite path in
    `AppearanceWriter` resolves through a plain dict lookup — so without this the only
    symptom would be `coat_level_id` quietly null on every split image.
    """
    conn = _StubConn({"manufacturers": [("amaco", 1)], "coat_levels": [("heavy", 9)]})

    with pytest.raises(ValueError, match="slightly_heavy"):
        normalizer_for(conn, adapter_for("amaco"))


def test_startup_accepts_a_vocabulary_that_publishes_them() -> None:
    conn = _StubConn({"manufacturers": [("amaco", 1)], "coat_levels": FULL_AMACO_COATS})

    normalizer = normalizer_for(conn, adapter_for("amaco"))

    assert normalizer.manufacturer is ManufacturerKey.AMACO


def test_an_empty_coat_order_is_checked_against_nothing() -> None:
    """Mayco until F8b: it publishes coat levels but classifies no image as a composite,
    so it declares no `coat_order` and the guard above has nothing to assert."""
    conn = _StubConn({"manufacturers": [("mayco", 2)]})

    assert normalizer_for(conn, adapter_for("mayco")).manufacturer is ManufacturerKey.MAYCO


@pytest.fixture
def conn() -> Iterator[Connection]:
    assert DSN
    with psycopg.connect(DSN) as connection:
        yield connection
        connection.rollback()


def _owner(conn: Connection, key: str) -> int:
    row = conn.execute("select id from manufacturers where key = %s", (key,)).fetchone()
    assert row is not None and isinstance(row[0], int)
    return row[0]


@needs_db
def test_a_colliding_key_resolves_to_its_owner(conn: Connection) -> None:
    """The bug, made real rather than argued about.

    Both inserts are legal — `coat_levels` and `clay_bodies` are unique per
    `(manufacturer_id, …)`, not globally — which is the point: the schema permits the
    collision the old flat lookup could not survive. Rolled back with the connection.
    """
    mayco = _owner(conn, "mayco")
    conn.execute(
        "insert into coat_levels (manufacturer_id, key, name, ordinal)"
        " values (%s, 'light', 'One brush coat', 9)",
        (mayco,),
    )
    conn.execute(
        "insert into clay_bodies (manufacturer_id, code, name, color_family)"
        " values (%s, '16', 'Colliding Clay', 'white')",
        (mayco,),
    )

    amaco_vocab = load_vocabularies(conn, manufacturer=ManufacturerKey.AMACO)
    mayco_vocab = load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)

    assert amaco_vocab.coat_levels["light"] != mayco_vocab.coat_levels["light"]
    assert amaco_vocab.clay_bodies["16"] != mayco_vocab.clay_bodies["16"]


@needs_db
def test_each_vocabulary_holds_only_its_owners_rows(conn: Connection) -> None:
    amaco_vocab = load_vocabularies(conn, manufacturer=ManufacturerKey.AMACO)
    mayco_vocab = load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)

    # AMACO's four thickness words against Mayco's four brush-coat counts. Seeded
    # together by 20260807000100 and never mixed into one scale.
    assert set(amaco_vocab.coat_levels) == {"light", "slightly_light", "slightly_heavy", "heavy"}
    assert set(mayco_vocab.coat_levels) == {"1", "2", "3", "4"}

    # Mayco names its clays instead of numbering them, so it has no `clay_bodies` rows at
    # all yet (F8a's remaining half). An empty dict is the honest answer, not AMACO's nine.
    assert amaco_vocab.clay_bodies.keys() >= {"11", "16", "32"}
    assert mayco_vocab.clay_bodies == {}

    # Unscoped vocabularies stay whole for both: a cone is a temperature, not a brand's
    # word for one, and `manufacturers` is the map the scoping is done through.
    assert amaco_vocab.cones == mayco_vocab.cones
    assert amaco_vocab.manufacturers == mayco_vocab.manufacturers
    assert {"amaco", "mayco"} <= set(amaco_vocab.manufacturers)

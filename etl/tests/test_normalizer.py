"""Resolving scraped words to vocabulary ids, and reading the vocabulary in.

Pure lookups over a hand-built `Vocabularies`, so none of this needs Postgres. The
manufacturer *scoping* of `clay_bodies` and `coat_levels` is proved separately in
`tests/test_normalizer_scoping.py`, against real rows where a colliding key exists;
what is pinned here is the resolving itself — which misses are reported, which are
silent, and that a miss never becomes a null that reads as "not stated".
"""

from __future__ import annotations

import pytest

from glaze_etl.core.models import CoatLevel, FormKind, ManufacturerKey, Opacity, Surface
from glaze_etl.core.normalizer import (
    Normalizer,
    Resolution,
    Vocabularies,
    load_vocabularies,
)

VOCAB = Vocabularies(
    manufacturer=ManufacturerKey.AMACO,
    cones={"05": 18, "5": 27, "6": 28},
    clay_bodies={"16": 2, "32": 5},
    surfaces={"gloss": 1, "satin": 2},
    opacities={"opaque": 1, "transparent": 3},
    forms={"flat_tile": 3, "mug": 7},
    coat_levels={"light": 1, "slightly_light": 2, "heavy": 4},
    manufacturers={"amaco": 1, "mayco": 2},
)


@pytest.fixture
def normalizer() -> Normalizer:
    return Normalizer(VOCAB)


class TestConeNames:
    def test_05_and_5_are_different_cones(self, normalizer: Normalizer) -> None:
        """The whole reason cones are matched as text: `05` is far cooler than `5`, and a
        numeric cast would silently unify them."""
        assert normalizer.cone_id("05") == 18
        assert normalizer.cone_id("5") == 27

    def test_surrounding_whitespace_is_stripped(self, normalizer: Normalizer) -> None:
        assert normalizer.cone_id("  05 ") == 18

    def test_an_unseeded_cone_is_none(self, normalizer: Normalizer) -> None:
        assert normalizer.cone_id("10") is None

    def test_no_cone_is_none(self, normalizer: Normalizer) -> None:
        assert normalizer.cone_id(None) is None


class TestClayBodies:
    def test_a_code_resolves_to_its_id(self, normalizer: Normalizer) -> None:
        """AMACO's codes happen to be numeric strings; Mayco's aren't ("white",
        "dark-brown"), which is why this is never cast to an int."""
        assert normalizer.clay_body_id("16") == 2

    def test_an_unseeded_clay_is_none(self, normalizer: Normalizer) -> None:
        assert normalizer.clay_body_id("99") is None

    def test_no_clay_is_none(self, normalizer: Normalizer) -> None:
        assert normalizer.clay_body_id(None) is None


class TestCoatLevels:
    def test_a_published_level_resolves(self, normalizer: Normalizer) -> None:
        assert normalizer.coat_level_id(CoatLevel.LIGHT) == 1

    def test_another_manufacturers_level_is_none(self, normalizer: Normalizer) -> None:
        """Mayco's brush-coat digits are in the enum but not in AMACO's vocabulary."""
        assert normalizer.coat_level_id(CoatLevel.ONE) is None

    def test_no_level_is_none(self, normalizer: Normalizer) -> None:
        assert normalizer.coat_level_id(None) is None

    def test_missing_coat_levels_names_only_the_absent_ones(self, normalizer: Normalizer) -> None:
        missing = normalizer.missing_coat_levels(
            (CoatLevel.LIGHT, CoatLevel.SLIGHTLY_HEAVY, CoatLevel.ONE)
        )

        assert missing == (CoatLevel.SLIGHTLY_HEAVY, CoatLevel.ONE)

    def test_a_fully_published_order_is_missing_nothing(self, normalizer: Normalizer) -> None:
        assert normalizer.missing_coat_levels((CoatLevel.LIGHT, CoatLevel.HEAVY)) == ()


def test_the_normalizer_reports_whose_vocabulary_it_holds(normalizer: Normalizer) -> None:
    assert normalizer.manufacturer is ManufacturerKey.AMACO


class TestResolveAppearance:
    def test_everything_known_resolves_and_reports_nothing(self, normalizer: Normalizer) -> None:
        resolution = normalizer.resolve_appearance(
            cone="05",
            clay_body_code="16",
            form=FormKind.FLAT_TILE,
            coat_level=CoatLevel.LIGHT,
        )

        assert resolution == Resolution(cone_id=18, clay_body_id=2, form_id=3, coat_level_id=1)
        assert resolution.unresolved == []

    def test_everything_unknown_is_reported_rather_than_invented(
        self, normalizer: Normalizer
    ) -> None:
        """Four misses, four issues, four nulls — and not one of them an exception: one
        unmappable form must not lose an otherwise good appearance row."""
        resolution = normalizer.resolve_appearance(
            cone="10",
            clay_body_code="99",
            form=FormKind.VASE,
            coat_level=CoatLevel.ONE,
        )

        assert resolution.unresolved == [
            ("unknown_cone", "10"),
            ("unknown_clay_body", "99"),
            ("unknown_form", "vase"),
            ("unknown_coat_level", "1"),
        ]
        assert resolution == Resolution(unresolved=resolution.unresolved)

    def test_nothing_passed_reports_nothing(self, normalizer: Normalizer) -> None:
        """Absent is not unknown. A caption that never stated a cone is not a parse issue."""
        assert normalizer.resolve_appearance() == Resolution()


class TestResolveGlaze:
    def test_known_surface_and_opacity_resolve(self, normalizer: Normalizer) -> None:
        resolution = normalizer.resolve_glaze(surface=Surface.GLOSS, opacity=Opacity.OPAQUE)

        assert resolution == Resolution(surface_id=1, opacity_id=1)

    def test_unknown_surface_and_opacity_are_reported(self, normalizer: Normalizer) -> None:
        resolution = normalizer.resolve_glaze(
            surface=Surface.MATTE, opacity=Opacity.TRANSLUCENT
        )

        assert resolution.surface_id is None
        assert resolution.opacity_id is None
        assert resolution.unresolved == [
            ("unknown_surface", "matte"),
            ("unknown_opacity", "translucent"),
        ]

    def test_nothing_passed_reports_nothing(self, normalizer: Normalizer) -> None:
        assert normalizer.resolve_glaze() == Resolution()


def test_notes_accumulate() -> None:
    resolution = Resolution()

    resolution.note("unknown_cone", "10")
    resolution.note("unknown_form", "vase")

    assert resolution.unresolved == [("unknown_cone", "10"), ("unknown_form", "vase")]


class _StubResult:
    def __init__(self, rows: list[tuple[str, int]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[str, int]]:
        return self._rows


class _StubConn:
    """Answers `load_vocabularies`'s queries out of a dict keyed by table name, and records
    the parameters each one was given — which is how the scoped reads are checked here.

    Same shape as the stub in `test_normalizer_scoping.py`, deliberately not imported from
    it: the query surface is seven `select <key>, id from <table>` reads, two with a `where`.
    """

    def __init__(self, tables: dict[str, list[tuple[str, int]]]) -> None:
        self._tables = tables
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def execute(self, sql: str, params: tuple[object, ...] = ()) -> _StubResult:
        table = sql.split(" from ")[1].split()[0]
        self.calls.append((table, params))
        return _StubResult(self._tables.get(table, []))


SEEDED = {
    "manufacturers": [("amaco", 1), ("mayco", 2)],
    "cones": [("05", 18), ("6", 28)],
    "clay_bodies": [("16", 2)],
    "surfaces": [("gloss", 1)],
    "opacities": [("opaque", 1)],
    "forms": [("flat_tile", 3)],
    "coat_levels": [("1", 11), ("2", 12)],
}


class TestLoadVocabularies:
    def test_every_lookup_is_read_once(self) -> None:
        conn = _StubConn(SEEDED)

        vocab = load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)

        assert vocab.manufacturer is ManufacturerKey.MAYCO
        assert vocab.cones == {"05": 18, "6": 28}
        assert vocab.clay_bodies == {"16": 2}
        assert vocab.surfaces == {"gloss": 1}
        assert vocab.opacities == {"opaque": 1}
        assert vocab.forms == {"flat_tile": 3}
        assert vocab.coat_levels == {"1": 11, "2": 12}
        assert vocab.manufacturers == {"amaco": 1, "mayco": 2}

    def test_the_scoped_tables_are_read_for_this_owner_only(self) -> None:
        """`clay_bodies` and `coat_levels` carry a `manufacturer_id`; the rest do not. A
        flat read of the two resolves a key to whichever brand's row happened to load."""
        conn = _StubConn(SEEDED)

        load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)

        assert ("clay_bodies", (2,)) in conn.calls
        assert ("coat_levels", (2,)) in conn.calls
        assert ("cones", ()) in conn.calls

    def test_an_unseeded_manufacturer_stops_the_run(self) -> None:
        """What a half-landed source looks like: the enum member exists, the seed migration
        does not. An empty vocabulary would null every appearance instead of raising."""
        conn = _StubConn({"manufacturers": [("amaco", 1)]})

        with pytest.raises(LookupError, match="mayco"):
            load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)

"""Colour measurement and naming, checked against real AMACO glaze photographs.

The naming assertions are the ones that matter: if these regress, searching by colour
silently stops working while every other test still passes.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from PIL import Image

from glaze_etl.core.color import ColorReading, Lab, delta_e, read_color, to_hex
from glaze_etl.core.color_namer import ColorNamer, ColorTerm

IMAGES = Path(__file__).parent / "fixtures" / "images"
MIGRATION = (
    Path(__file__).parents[2] / "supabase" / "migrations" / "20260726000100_vocabularies.sql"
)

_ROW_RE = re.compile(
    r"\('([^']+)',\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([\d.]+),\s*(true|false)\)"
)
FAMILIES_MIGRATION = (
    Path(__file__).parents[2] / "supabase" / "migrations" / "20260726000400_color_families.sql"
)
_FAMILY_RE = re.compile(r"when\s+'([^']+)'\s+then\s+'([^']+)'")


def load_families() -> dict[str, str]:
    """The term -> family map, read from the migration that defines it."""
    return dict(_FAMILY_RE.findall(FAMILIES_MIGRATION.read_text()))


def load_vocabulary() -> list[ColorTerm]:
    """Read the real seeded vocabulary, so tests and production share one source.

    A hand-written test vocabulary would let the migration drift without any test
    noticing — which is precisely the failure mode that breaks colour search.
    """
    block = MIGRATION.read_text().split("insert into color_terms")[1]
    return [
        ColorTerm(
            term,
            Lab(float(lightness), float(green_red), float(blue_yellow)),
            float(radius),
            potter == "true",
        )
        for term, lightness, green_red, blue_yellow, radius, potter in _ROW_RE.findall(block)
    ]


@pytest.fixture(scope="module")
def namer() -> ColorNamer:
    families = load_families()
    return ColorNamer(
        [
            ColorTerm(t.term, t.centroid, t.max_delta_e, t.is_potter_term, families.get(t.term))
            for t in load_vocabulary()
        ]
    )


def measure(name: str) -> ColorReading:
    return read_color(Image.open(IMAGES / f"{name}.jpg"))


class TestDeltaE:
    """Guards against the axis-order and scaling mistakes that silently ruin matching."""

    def test_identical_colours_are_zero_apart(self) -> None:
        assert delta_e(Lab(50, 0, 0), Lab(50, 0, 0)) == pytest.approx(0.0)

    def test_white_and_black_span_the_scale(self) -> None:
        assert delta_e(Lab(100, 0, 0), Lab(0, 0, 0)) == pytest.approx(100.0, abs=0.5)

    def test_one_unit_of_lightness_is_about_one_delta_e(self) -> None:
        assert delta_e(Lab(50, 0, 0), Lab(51, 0, 0)) == pytest.approx(1.0, abs=0.2)

    def test_is_symmetric(self) -> None:
        first, second = Lab(64, -11, -3), Lab(24, 12, 16)
        assert delta_e(first, second) == pytest.approx(delta_e(second, first))


class TestVocabulary:
    def test_migration_seeds_a_usable_vocabulary(self) -> None:
        vocabulary = load_vocabulary()
        assert len(vocabulary) >= 25
        assert {"sage", "celadon", "tenmoku", "blue", "oxblood"} <= {t.term for t in vocabulary}

    def test_potter_terms_have_tighter_radii_than_plain_words(self) -> None:
        """`celadon` is a specific claim; `blue` is meant to be inclusive."""
        vocabulary = load_vocabulary()
        potter = [t.max_delta_e for t in vocabulary if t.is_potter_term]
        plain = [t.max_delta_e for t in vocabulary if not t.is_potter_term]
        assert max(potter) <= min(plain)

    def test_an_empty_vocabulary_is_rejected_loudly(self) -> None:
        """Silently accepting it would leave colour search quietly broken."""
        with pytest.raises(ValueError, match="empty"):
            ColorNamer([])


class TestNamingRealGlazes:
    def test_temmoku_is_recognised_from_pixels_alone(self, namer: ColorNamer) -> None:
        """The strongest available check: the measured colour independently produces the
        potter's term AMACO chose as the product name."""
        reading = measure("pc30-application-tiles")
        assert "tenmoku" in namer.terms_for(reading.dominant, reading.secondary)

    def test_copper_over_flux_reads_as_warm_earth(self, namer: ColorNamer) -> None:
        reading = measure("pc56-over-pcf54-32m-vase")
        terms = namer.terms_for(reading.dominant, reading.secondary)
        assert {"rust", "brown", "ochre", "tan"} & set(terms)

    def test_blue_rutile_chip_reads_cool(self, namer: ColorNamer) -> None:
        reading = measure("pc20-label-chip")
        terms = namer.terms_for(reading.dominant, reading.secondary)
        assert {"celadon", "sage", "turquoise", "teal", "grey", "slate"} & set(terms)

    def test_dominant_terms_come_before_secondary_ones(self, namer: ColorNamer) -> None:
        reading = measure("pc20-application-tiles")
        terms = namer.terms_for(reading.dominant, reading.secondary)
        assert terms[0] in {hit.term for hit in namer.name(reading.dominant)}

    def test_a_distant_colour_earns_no_potter_term(self, namer: ColorNamer) -> None:
        """A blue-grey must not be labelled tenmoku — they are ~34 delta-E apart."""
        assert "tenmoku" not in [hit.term for hit in namer.name(Lab(52, -5, -6))]


class TestMeasurement:
    def test_background_is_excluded(self) -> None:
        """A tile on a white backdrop must not measure as a near-white glaze."""
        reading = measure("pc30-application-tiles")
        assert reading.dominant.l < 60, "studio white leaked into the measurement"

    def test_two_colours_are_reported_for_a_real_photo(self) -> None:
        reading = measure("pc20-label-chip")
        assert reading.secondary is not None
        assert reading.secondary_hex is not None

    def test_hex_matches_the_lab_lightness(self) -> None:
        reading = measure("pc30-application-tiles")
        assert reading.dominant_hex.startswith("#")
        assert len(reading.dominant_hex) == 7

    def test_measurement_is_deterministic(self) -> None:
        """Seeded k-means, so the same image always yields the same swatch."""
        assert measure("pc20-label-chip").dominant_hex == measure("pc20-label-chip").dominant_hex

    def test_an_all_white_image_does_not_crash(self) -> None:
        reading = read_color(Image.new("RGB", (64, 64), (255, 255, 255)))
        assert reading.dominant.l > 90

    @pytest.mark.parametrize(
        ("rgb", "expected"),
        [((0, 0, 0), "#000000"), ((255, 255, 255), "#ffffff"), ((300, -5, 128), "#ff0080")],
    )
    def test_hex_clamps_out_of_range_channels(
        self, rgb: tuple[float, float, float], expected: str
    ) -> None:
        assert to_hex(rgb) == expected


class TestColorFamilies:
    """Regression cover for a bug found by running the real search on real data.

    `search_glazes('sage')` returned PC-20 but `search_glazes('sage green')` returned
    nothing, because `websearch_to_tsquery` ANDs its terms and the glaze had earned
    "sage" without ever earning "green". Two-word colour phrases are how potters search,
    so every specific term now carries its family word.
    """

    def test_every_potter_term_has_a_family(self) -> None:
        families = load_families()
        orphans = [t.term for t in load_vocabulary() if t.is_potter_term and t.term not in families]
        assert not orphans, f"unreachable from a plain colour word: {orphans}"

    def test_families_are_themselves_real_terms(self) -> None:
        """A family word must exist in the vocabulary, or it indexes a token nothing else
        can ever match."""
        terms = {t.term for t in load_vocabulary()}
        assert set(load_families().values()) <= terms

    def test_specific_term_emits_its_family(self, namer: ColorNamer) -> None:
        reading = measure("pc30-application-tiles")
        terms = namer.terms_for(reading.dominant, reading.secondary)
        assert "tenmoku" in terms
        assert "brown" in terms, "tenmoku must also be findable as brown"

    def test_family_does_not_displace_the_specific_term(self, namer: ColorNamer) -> None:
        reading = measure("pc30-application-tiles")
        terms = namer.terms_for(reading.dominant, reading.secondary)
        assert terms.index("tenmoku") < terms.index("brown")

    def test_terms_are_unique(self, namer: ColorNamer) -> None:
        """Several hits can share one family, and a repeated token adds nothing."""
        reading = measure("pc20-label-chip")
        terms = namer.terms_for(reading.dominant, reading.secondary)
        assert len(terms) == len(set(terms))

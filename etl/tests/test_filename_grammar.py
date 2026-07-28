"""Every case here is a real filename taken from AMACO's CDN, not an invented one."""

from __future__ import annotations

import pytest

from glaze_etl.core.models import Confidence, FormKind, ImageRole
from glaze_etl.sources.amaco.filename_grammar import interpret_filename, normalize_code


class TestLayering:
    def test_glued_over_is_split(self) -> None:
        """`PG-55overSM-11` has no separator around `over` — the commonest layering form."""
        f = interpret_filename("PG-55overSM-11_Cone6.jpg", "PG-55")
        assert f.role is ImageRole.LAYERED
        assert f.subject_code == "PG-55"
        assert f.layered_over_code == "SM-11"
        assert f.cone == "6"
        assert f.confidence is Confidence.HIGH

    def test_separated_over(self) -> None:
        f = interpret_filename("CR-61_over_PC-16_1280pxX1280px_ProductPage.jpg", "CR-61")
        assert (f.subject_code, f.layered_over_code) == ("CR-61", "PC-16")
        assert f.confidence is Confidence.HIGH

    def test_single_letter_line_code_as_base(self) -> None:
        f = interpret_filename("PG-55overC-1_Cone6.jpg", "PG-55")
        assert (f.subject_code, f.layered_over_code) == ("PG-55", "C-1")

    def test_subject_is_the_top_glaze_not_the_page(self) -> None:
        """Found on PCF-54's page, but it is a photograph of PC-70 over PCF-54."""
        f = interpret_filename("PC-70_over_PCF-54_16M_Vase_Website.jpg", "PCF-54")
        assert f.subject_code == "PC-70"
        assert f.layered_over_code == "PCF-54"

    def test_multi_code_without_over_is_not_a_pair(self) -> None:
        """Three glazes and nothing to order them. Must not be guessed into a pair."""
        f = interpret_filename("SM-11_CO-7_PC-30_Medina_Website.jpg", "PC-30")
        assert f.layered_over_code is None
        assert f.combination_codes == ("SM-11", "CO-7", "PC-30")
        assert f.confidence is Confidence.LOW


class TestClayBody:
    @pytest.mark.parametrize(
        ("filename", "expected"),
        [
            ("PC-70_over_PCF-54_16M_Vase_Website.jpg", 16),
            ("PC-56_over_PCF-54_32M_Vase_Website.jpg", 32),
        ],
    )
    def test_clay_number_extracted(self, filename: str, expected: int) -> None:
        assert interpret_filename(filename, "PCF-54").clay_body_number == expected

    def test_unknown_clay_number_rejected(self) -> None:
        """`99M` is not a clay AMACO sells, so it is not a clay body."""
        assert interpret_filename("PC-1_over_PC-2_99M_Vase.jpg", "PC-1").clay_body_number is None

    def test_tile_dimension_is_not_a_clay_body(self) -> None:
        f = interpret_filename("LG-65_Amber_Blick_FishTile_5-16-Square-WEB.jpg", "LG-65")
        assert f.clay_body_number is None


class TestRoles:
    def test_label_chip(self) -> None:
        f = interpret_filename("C-5_Charcoal_Cone5_Chip-HiRes.jpg", "C-5", "C-05 Charcoal")
        assert f.role is ImageRole.LABEL_CHIP
        assert (f.subject_code, f.cone, f.form) == ("C-5", "5", FormKind.FLAT_TILE)
        assert f.confidence is Confidence.HIGH

    @pytest.mark.parametrize(
        "filename",
        [
            "large_pc20-application-tiles-and-sake-cup-2048px.jpg",
            "PC-72_FirIce_ApplicationTiles_WEB.jpg",  # CamelCase, no separators
            "PCF-54_ApplicationTiles_WebsiteSwatch.jpg",
        ],
    )
    def test_coats_composite(self, filename: str) -> None:
        assert interpret_filename(filename).role is ImageRole.COATS_COMPOSITE

    def test_coats_composite_carries_no_coat_level(self) -> None:
        """Thickness is a property of a region inside the image, decided by the splitter."""
        assert interpret_filename("PCF-54_ApplicationTiles_WebsiteSwatch.jpg").coat_level is None

    def test_line_chart_has_no_single_subject(self) -> None:
        """A whole-line chart is not a picture of the product whose page it sits on."""
        f = interpret_filename("gloss-glazes-color-chart-2048px.jpg", "LG-65")
        assert f.role is ImageRole.LINE_CHART
        assert f.subject_code is None

    def test_vessel_beats_tile(self) -> None:
        f = interpret_filename("SH-22_Acai_Matte_Bowl_2048px.jpg", "SH-22", "SH-22 Acai Matte")
        assert f.role is ImageRole.IN_USE
        assert f.form is FormKind.BOWL


class TestCodeExtraction:
    def test_pcf_wins_over_pc(self) -> None:
        """Longest-first alternation: `PCF-54` must not parse as PC with a stray F."""
        assert interpret_filename("PCF-54_Cone5_WebsiteSwatch.jpg").subject_code == "PCF-54"

    def test_leading_zeros_collapse(self) -> None:
        assert normalize_code("c", "05") == "C-5"

    def test_digit_prefixed_text_is_not_a_code(self) -> None:
        """`223lg` must not yield LG-something."""
        f = interpret_filename("223lg.jpg", "O-20")
        assert f.role is ImageRole.OTHER
        assert f.confidence is Confidence.LOW

    def test_lowercase_unseparated_code(self) -> None:
        assert interpret_filename("o20-bluebell-basket-2048px.jpg").subject_code == "O-20"

    def test_part_number_is_not_a_code(self) -> None:
        """`HF-127_China_Blue_35503A` — 35503A is a warehouse part number."""
        f = interpret_filename(
            "HF-127_China_Blue_35503A_6x6_Square_Tile_WEB.jpg", "HF-127", "HF-127 China Blue"
        )
        assert f.subject_code == "HF-127"
        assert f.combination_codes == ()


class TestConfidence:
    def test_no_code_in_filename_is_never_high(self) -> None:
        """The subject would be pure assumption from which page we found it on."""
        assert interpret_filename("37418X.jpg", "V-325").confidence is Confidence.LOW

    def test_product_name_words_are_not_unresolved(self) -> None:
        """The filename restating the product's own name teaches us nothing new."""
        f = interpret_filename(
            "CR-61_SpeckledYellow_1280pxX1280px_Website.jpg", "CR-61", "CR-61 Speckled Yellow"
        )
        assert f.unmatched_tokens == ()
        assert f.confidence is Confidence.HIGH

    def test_genuine_unknown_lowers_confidence_and_is_reported(self) -> None:
        """`Blick` is a retailer, `JenH` an artist — indistinguishable, so neither is
        promoted to a credit. They surface for review instead."""
        f = interpret_filename(
            "LG-65_Amber_Blick_FishTile_5-16-Square-WEB.jpg", "LG-65", "LG-65 Amber"
        )
        assert f.credit is None
        assert "blick" in f.unmatched_tokens
        assert f.confidence is Confidence.MEDIUM


class TestEvidence:
    def test_every_fired_rule_is_recorded(self) -> None:
        f = interpret_filename("PC-56_over_PCF-54_32M_Vase_Website.jpg", "PCF-54")
        assert f.evidence["layering"] == "PC-56 over PCF-54"
        assert f.evidence["clay_body"] == "32m"
        assert f.evidence["glaze_code"] == "PC-56,PCF-54"

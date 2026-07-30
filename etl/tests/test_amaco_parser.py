"""AMACO-specific parser and badge assertions, per checked-in page.

The source-agnostic half — every fixture page yields a code, a line, images and a
price — lives in test_source_contract.py, parametrized over the registry, so a new
source gets that coverage by adding fixtures rather than by copying tests. What stays
here is irreducibly AMACO: exact codes and line names, its badge iconography, its
sitemap shape.
"""

from __future__ import annotations

import re

import pytest

from glaze_etl.core.models import Opacity
from glaze_etl.sources.amaco.adapter import is_glaze_slug, parse_sitemap
from glaze_etl.sources.amaco.parser import clean_text, parse_product, strip_cache_buster
from tests.conftest import all_product_slugs, fixture_dir, snapshot_for

SLUGS = all_product_slugs()
FIXTURES = fixture_dir("amaco")


@pytest.mark.parametrize("slug", SLUGS)
def test_no_unrecognised_badge_icons(slug: str) -> None:
    """A new AMACO icon should fail here rather than quietly cost us a filter."""
    assert parse_product(snapshot_for(slug)).badges.unknown_icons == ()


class TestGallery:
    def test_related_product_carousels_are_excluded(self) -> None:
        """The page also advertises kiln elements; only the product's own photos count."""
        product = parse_product(snapshot_for("hf-127-china-blue"))
        names = [i.raw_filename for i in product.images]
        assert names == ["HF-127_China_Blue_35503A_6x6_Square_Tile_WEB.jpg"]
        assert not any("Elem_1_or_3" in n for n in names)

    def test_cache_buster_is_stripped(self) -> None:
        assert (
            strip_cache_buster("PC-20_6x6_Label_Tile_Chip-hires__54961.1659532780.jpg")
            == "PC-20_6x6_Label_Tile_Chip-hires.jpg"
        )


class TestCodesAndLines:
    @pytest.mark.parametrize(
        ("slug", "code", "line_code", "line_name"),
        [
            ("c-05-charcoal", "C-5", "C", "Celadon"),
            ("pcf-54-flux-blossom", "PCF-54", "PCF", "Potter's Choice Flux"),
            ("sm-02-stone", "SM-2", "SM", "Satin Matte"),
            ("v-325-baby-blue-underglaze", "V-325", "V", "Velvet Underglaze"),
        ],
    )
    def test_code_and_line(self, slug: str, code: str, line_code: str, line_name: str) -> None:
        product = parse_product(snapshot_for(slug))
        assert (product.code, product.line_code, product.line_name) == (code, line_code, line_name)


class TestBadges:
    def test_ap_seal_and_opacity(self) -> None:
        badges = parse_product(snapshot_for("pc-20-blue-rutile")).badges
        assert badges.opacity is Opacity.OPAQUE
        assert badges.ap_seal is True
        assert badges.spray_safe is False

    def test_cl_seal_reads_as_not_ap(self) -> None:
        """PC-45 carries the CL (cautionary label) seal, not AP."""
        assert parse_product(snapshot_for("pc-45-dark-green")).badges.ap_seal is False

    def test_wordless_fork_and_knife_is_food_safe(self) -> None:
        """The UUID-named icon is the wordless food-safe glyph, verified by opening it."""
        assert parse_product(snapshot_for("pc-20-blue-rutile")).badges.food_safe is True

    def test_translucent_opacity(self) -> None:
        assert parse_product(snapshot_for("c-05-charcoal")).badges.opacity is Opacity.TRANSLUCENT


class TestDiscovery:
    def test_sitemap_parses(self) -> None:
        refs = parse_sitemap((FIXTURES / "sitemap-products-1.xml").read_text())
        assert len(refs) > 900
        assert all(str(r.url).startswith("https://shop.amaco.com/") for r in refs)

    def test_sitemap_carries_no_lastmod(self) -> None:
        """Documents a real constraint: AMACO emits bare <loc> entries.

        Delta crawling therefore cannot be driven from the sitemap and must come from
        per-URL conditional GETs in the Fetcher. If AMACO ever starts publishing
        lastmod this test fails, which is the notification we want.
        """
        refs = parse_sitemap((FIXTURES / "sitemap-products-1.xml").read_text())
        assert all(r.lastmod is None for r in refs)

    def test_glaze_slugs_are_kept_and_equipment_dropped(self) -> None:
        assert is_glaze_slug("pc-20-blue-rutile")
        assert is_glaze_slug("/pcf-54-flux-blossom/")
        assert is_glaze_slug("c-05-charcoal")
        assert not is_glaze_slug("sr-20-slab-roller")
        assert not is_glaze_slug("thermocouple-type-k")
        assert not is_glaze_slug("element-1-or-3")

    def test_sitemap_filtered_to_a_plausible_glaze_count(self) -> None:
        """~954 products in the catalog, of which roughly a third are glazes."""
        refs = parse_sitemap((FIXTURES / "sitemap-products-1.xml").read_text())
        glazes = [r for r in refs if is_glaze_slug(r.external_id)]
        assert 200 < len(glazes) < 450, len(glazes)


class TestTextCleaning:
    """JSON-LD carries prose as the site authored it, entities and all. 128 glazes had
    literal "&nbsp;" or "&deg;" reaching the app before this."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Texture accentuates this effect.&nbsp;", "Texture accentuates this effect."),
            ("Fires to 1222&deg;C", "Fires to 1222°C"),
            ("&ldquo;floating&rdquo; blue", "“floating” blue"),
            ("Glazes &amp; Underglazes", "Glazes & Underglazes"),
            ("AMACO&reg; celadon", "AMACO® celadon"),
            ("caf&eacute; au lait", "café au lait"),
            ("collapse   inner    runs", "collapse inner runs"),
            ("  trim edges  ", "trim edges"),
        ],
    )
    def test_entities_decoded_and_whitespace_normalised(self, raw: str, expected: str) -> None:
        assert clean_text(raw) == expected

    def test_real_description_has_no_entities_left(self) -> None:
        product = parse_product(snapshot_for("pc-20-blue-rutile"))
        assert product.description
        assert "&" not in product.description or "&amp;" not in product.description
        assert "&nbsp;" not in product.description

    @pytest.mark.parametrize("slug", SLUGS)
    def test_no_fixture_leaks_an_entity(self, slug: str) -> None:
        product = parse_product(snapshot_for(slug))
        for field in (product.name, product.description or ""):
            assert not re.search(r"&[a-zA-Z#0-9]+;", field), field

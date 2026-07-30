"""Invariants every source adapter must hold, plus the seam itself.

`core/` must never import from `sources/` — that import direction is exactly how the
loader ended up hardcoding AMACO's cone-category vocabulary (roadmap F1). The tripwire
here is a text scan rather than an import graph so it catches lazy imports too.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from glaze_etl.sources import SOURCES, adapter_for
from glaze_etl.sources.amaco.adapter import AmacoAdapter
from tests.conftest import all_product_slugs, snapshot_for

CORE = Path(__file__).parent.parent / "glaze_etl" / "core"


def test_core_never_imports_sources() -> None:
    offenders = [
        f"{path.name}:{lineno}"
        for path in sorted(CORE.glob("*.py"))
        for lineno, line in enumerate(path.read_text().splitlines(), start=1)
        if "glaze_etl.sources" in line
    ]
    assert not offenders, f"core/ reaches into sources/: {offenders}"


@pytest.mark.parametrize("source", sorted(key.value for key in SOURCES))
def test_every_checked_in_page_parses_to_the_basics(source: str) -> None:
    """The source-agnostic parse contract: code, line, gallery images, a price.

    Parametrized over the registry and driven by `fixtures/<key>/product-*.html`, so a
    new source is covered by checking in fixtures, not by copying this test. The
    source-specific assertions (exact codes, badge iconography) live in that source's
    own test module — test_amaco_parser.py sets the pattern.
    """
    adapter = adapter_for(source)
    slugs = all_product_slugs(source)
    assert slugs, f"no product fixtures for {source} — capture some before registering it"
    for slug in slugs:
        product = adapter.parse(snapshot_for(slug, source))
        assert product.manufacturer is adapter.manufacturer
        assert product.code, f"{source}/{slug} produced no code"
        assert product.line_code, f"{source}/{slug} produced no line code"
        assert product.images, f"{source}/{slug} produced no gallery images"
        assert product.price_min is not None, f"{source}/{slug} produced no price"


class TestRegistry:
    def test_known_key_resolves(self) -> None:
        assert isinstance(adapter_for("amaco"), AmacoAdapter)

    def test_unknown_key_names_the_known_ones(self) -> None:
        with pytest.raises(ValueError, match=r"'wedgwood'.*amaco"):
            adapter_for("wedgwood")


class TestUrlIdentity:
    def test_product_ref_and_external_id_round_trip(self) -> None:
        adapter = AmacoAdapter()
        ref = adapter.product_ref("pc-20-blue-rutile")
        assert str(ref.url) == "https://shop.amaco.com/pc-20-blue-rutile/"
        assert ref.external_id == "pc-20-blue-rutile"
        assert adapter.external_id_for(str(ref.url)) == "pc-20-blue-rutile"

    def test_slug_is_tolerant_of_stray_slashes(self) -> None:
        ref = AmacoAdapter().product_ref("/pc-20-blue-rutile/")
        assert str(ref.url) == "https://shop.amaco.com/pc-20-blue-rutile/"


class TestAmacoConeCategories:
    def test_known_brackets_map(self) -> None:
        adapter = AmacoAdapter()
        assert adapter.cone_range_for_category("Mid-High Fire Glazes") == ("5", "6")
        assert adapter.cone_range_for_category("Low Fire Glazes") == ("05", "05")

    def test_unknown_category_returns_none(self) -> None:
        # None leaves the line's cone range null — findable by every cone query —
        # and the loader files an `unmapped_cone_category` issue instead of guessing.
        assert AmacoAdapter().cone_range_for_category("Underglazes") is None

"""What is irreducibly Mayco: its SKU spelling, its attribute vocabulary, its filenames.

The source-agnostic half of this coverage lives in `test_source_contract.py`, which
parametrizes over `SOURCES` and so already asserts that every checked-in Mayco product
parses to a code, a line, an image and a price. What stays here is everything that would
be wrong to assert about a *different* source: exact codes and line slugs, the three ways
Mayco spells a safety claim, its cone-per-line mapping, and its image grammar.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import pytest

from glaze_etl.core.models import (
    Confidence,
    FormKind,
    ImageRole,
    ParsedProduct,
    RawSnapshot,
)
from glaze_etl.sources import adapter_for
from glaze_etl.sources.mayco.adapter import (
    MaycoAdapter,
    is_glaze,
    parse_allowlist,
    parse_sitemap,
    slug_from,
)
from glaze_etl.sources.mayco.filename_grammar import interpret_filename, normalize_sku
from glaze_etl.sources.mayco.parser import (
    _line,
    _value_token,
    clean_text,
    parse_product,
)
from glaze_etl.sources.mayco.vocabulary import CATEGORY_CONE_RANGE, CONE_UNSTATED
from tests.conftest import all_product_slugs, fixture_dir, raw_snapshot, snapshot_for

SLUGS = all_product_slugs("mayco")
FIXTURES = fixture_dir("mayco")
ADAPTER = MaycoAdapter()


def parse(slug: str) -> ParsedProduct:
    return parse_product(snapshot_for(slug, "mayco"))


@pytest.mark.parametrize("slug", SLUGS)
def test_no_unrecognised_attributes(slug: str) -> None:
    """Every attribute on every fixture is either mapped or explicitly ignored.

    Mayco publishes six attribute names and only two carry badges, so the other four have
    to be listed as ignored. If they were not, this fails on every fixture and production
    files three parse issues per glaze — which would bury the one real signal this field
    exists for, a *new* Mayco property appearing.
    """
    assert parse(slug).badges.unknown_icons == ()


class TestCodes:
    """The SKU is the only trustworthy source of a Mayco code."""

    @pytest.mark.parametrize(
        ("slug", "code", "name"),
        [
            # The slug carries no code at all — the whole reason the parser reads `sku`
            # rather than deriving a code from the URL the way AMACO's does.
            ("lilac", "EZ-112", "Lilac"),
            # Mayco's own SKUs disagree about the separator; normalizing inserts it.
            ("fd258-pure-white", "FD-258", "Pure White"),
            ("pb001-pure-brilliance-clear-brushing", "PB-001", "Pure Brilliance Clear Brushing"),
            # Undashed slug, dashed SKU, and the two must not produce different codes.
            ("sw214-micro-pearl", "SW-214", "Micro Pearl"),
            ("sw-197-fossil-rock", "SW-197", "Fossil Rock"),
        ],
    )
    def test_code_comes_from_the_sku(self, slug: str, code: str, name: str) -> None:
        product = parse(slug)
        assert (product.code, product.name) == (code, name)

    def test_zero_padding_is_kept(self) -> None:
        """`PB001` becomes `PB-001`, not `PB-1`.

        The opposite of AMACO's `normalize_code`, which strips leading zeros to collapse
        `c-05-charcoal` and `C-5 Charcoal` into one identity. Mayco pads to three digits
        consistently, so the padding is its spelling and dropping it would print a code
        Mayco never does.
        """
        assert normalize_sku("PB001") == "PB-001"
        assert normalize_sku("SW-001") == "SW-001"

    def test_woocommerce_dedup_suffix_is_dropped(self) -> None:
        """`SW-402-15649` is Dark Flux with a duplicate-SKU suffix, not a `-15649` variant."""
        assert normalize_sku("SW-402-15649") == "SW-402"

    def test_a_code_with_no_digits_survives(self) -> None:
        """Three SKUs are letters only. Nothing to normalize beats inventing a number."""
        assert normalize_sku("PBDIP") == "PBDIP"
        assert normalize_sku("NT-CLR") == "NT-CLR"


class TestLines:
    """The line is the category, never the code prefix."""

    @pytest.mark.parametrize(
        ("slug", "line_code", "line_name"),
        [
            ("sw-197-fossil-rock", "stoneware", "Stoneware"),
            ("sc-104-grape-expectations", "stroke-coat", "Stroke & Coat®"),
            ("sp-288-speckled-tu-tu-tango", "speckled-stroke-coat", "Speckled Stroke & Coat®"),
            ("cg-999-jazz-notes", "jungle-gems", "Jungle Gems™"),
            ("ug-236-grey", "fundamentals-underglaze", "Fundamentals® Underglaze"),
            ("rk-107-oil-slick", "raku", "Raku"),
        ],
    )
    def test_line_from_the_fired_child_category(
        self, slug: str, line_code: str, line_name: str
    ) -> None:
        product = parse(slug)
        assert (product.line_code, product.line_name) == (line_code, line_name)

    def test_the_code_prefix_is_not_the_line(self) -> None:
        """FN-219 is an *Elements* glaze, and this is why the line cannot be inferred.

        Measured across the catalog: `SG` spans Designer Liner, Snow Gems and Cobblestone,
        and `SW` spans seven lines. A prefix-to-line table would be wrong for all of them.
        """
        product = parse("fn-219-lustre-green")
        assert product.code == "FN-219"
        assert product.line_code == "elements-and-elements-chunkies"

    def test_trademark_glyphs_are_unescaped_once(self) -> None:
        """The API sends `Stroke &amp; Coat®`; the app must not render the entity."""
        assert "&amp;" not in str(parse("sc-104-grape-expectations").line_name)

    def test_a_product_outside_every_line_still_parses(self) -> None:
        """Four fired products sit under no child category. A null line is not a failure —
        `upsert_line` returns None and the glaze loads without one."""
        product = parse_product(
            raw_snapshot(
                "noline-cr901-waterfall",
                str(ADAPTER.product_ref("cr901-waterfall").url),
                "mayco",
            )
        )
        assert (product.code, product.line_code, product.cone_category) == ("CR-901", None, None)


class TestNestedLines:
    """The line must survive Mayco not listing a product's ancestors."""

    @staticmethod
    def _categories(*pairs: tuple[str, str]) -> list[dict[str, object]]:
        return [{"slug": slug, "name": slug, "link": link} for slug, link in pairs]

    def test_a_nested_product_resolves_to_its_parent_line(self) -> None:
        """How all 630 resolve today: Mayco lists `ritual-glazes` alongside `bead`."""
        assert _line(
            self._categories(
                ("bead", "https://www.maycocolors.com/product-category/color/fired/"
                         "ritual-glazes/bead/"),
                ("ritual-glazes", "https://www.maycocolors.com/product-category/color/fired/"
                                  "ritual-glazes/"),
            )
        ) == ("ritual-glazes", "ritual-glazes")

    def test_the_line_survives_the_parent_not_being_listed(self) -> None:
        """The dependency this covers is invisible until it breaks: with only the deep
        category listed, requiring a listed direct child returns no line — and therefore no
        cone range either — for every nested product, with nothing logged."""
        assert _line(
            self._categories(
                ("bead", "https://www.maycocolors.com/product-category/color/fired/"
                         "ritual-glazes/bead/"),
            )
        ) == ("ritual-glazes", "ritual-glazes")

    def test_a_category_outside_the_fired_branch_is_not_a_line(self) -> None:
        assert (
            _line(
                self._categories(
                    ("softees", "https://www.maycocolors.com/product-category/color/"
                                "non-fired/softees/"),
                )
            )
            is None
        )


class TestCones:
    def test_cone_category_is_the_line(self) -> None:
        """Cone lands on the line because that is where the schema keeps it: `upsert_line`
        coalesces cone_from/cone_to, so a per-product category would be last-write-wins
        inside a line."""
        product = parse("sw-197-fossil-rock")
        assert product.cone_category == "stoneware"
        assert ADAPTER.cone_range_for_category("stoneware") == ("6", "10")

    def test_a_line_mayco_states_no_cone_for_is_left_unset(self) -> None:
        """Raku is fired in a pit and Mayco publishes no cone for it.

        `cone_category=None` rather than an unmapped label, because the loader reads an
        unmapped label as *our* coverage gap and files `unmapped_cone_category`. Saying we
        failed to map raku would be a lie about the mapping.
        """
        product = parse("rk-107-oil-slick")
        assert product.line_code == "raku"
        assert product.cone_category is None

    def test_every_cone_unstated_line_is_absent_from_the_mapping(self) -> None:
        """The two tables must not disagree: a line cannot be both unstated and mapped."""
        assert not (CONE_UNSTATED & CATEGORY_CONE_RANGE.keys())

    @pytest.mark.parametrize("slug", SLUGS)
    def test_a_line_is_either_mapped_or_deliberately_unstated(self, slug: str) -> None:
        line = parse(slug).line_code
        if line is None:
            return
        assert line in CATEGORY_CONE_RANGE or line in CONE_UNSTATED, (
            f"{line!r} has no cone range and is not in CONE_UNSTATED — the loader will file "
            f"unmapped_cone_category for every glaze in it"
        )


class TestPrices:
    def test_minor_units_become_currency(self) -> None:
        """`"695"` with `currency_minor_unit: 2` is $6.95. Reading it as dollars is a 100x
        error on every glaze in the catalog, so this is the single most consequential line
        in the parser."""
        product = parse("cg-999-jazz-notes")
        assert (product.price_min, product.price_max) == (6.95, 20.50)

    def test_a_price_range_carries_the_real_spread(self) -> None:
        """398 products are sold in several jar sizes; the flat `price` is only the
        cheapest of them, so `price_range` is what the app's "From $…" needs."""
        product = parse("sw-197-fossil-rock")
        assert (product.price_min, product.price_max) == (14.25, 80.00)

    def test_a_single_price_fills_both_ends(self) -> None:
        product = parse("sw214-micro-pearl")
        assert (product.price_min, product.price_max) == (16.00, 16.00)

    def test_a_price_with_no_scale_refuses_to_guess(self) -> None:
        """Defaulting the minor unit to 0 made the divisor 1, so "695" read as $695.00 —
        the exact 100x error this class exists to prevent, and silent because a plausible
        number renders fine. Defaulting to 2 would be a guess about the currency instead.
        All 651 products send the field, so its absence means the response is not the shape
        we think it is."""
        body = json.dumps(
            [
                {
                    "sku": "SW-998",
                    "name": "No Scale",
                    "permalink": "https://www.maycocolors.com/product/sw998-x/",
                    "categories": [],
                    "prices": {"price": "695"},
                    "images": [{"src": "https://www.maycocolors.com/wp-content/x/sw-998.jpg"}],
                }
            ]
        )
        with pytest.raises(ValueError, match="currency_minor_unit"):
            parse_product(_synthetic_snapshot(body))

    def test_no_price_at_all_needs_no_scale(self) -> None:
        """The refusal above must not reject a product that simply has no price: there is
        nothing to divide, so nothing to get wrong."""
        body = json.dumps(
            [
                {
                    "sku": "SW-997",
                    "name": "Unpriced",
                    "permalink": "https://www.maycocolors.com/product/sw997-x/",
                    "categories": [],
                    "prices": {},
                    "images": [{"src": "https://www.maycocolors.com/wp-content/x/sw-997.jpg"}],
                }
            ]
        )
        assert parse_product(_synthetic_snapshot(body)).price_min is None

    def test_an_unpriced_product_is_none_not_zero(self) -> None:
        """15 fired products carry `"0"`. "From $0.00" is a wrong answer where "no price"
        is the true one, and 0.0 would also pass any `is not None` check downstream."""
        product = parse_product(
            raw_snapshot(
                "zeroprice-sw229-mood-ring",
                str(ADAPTER.product_ref("sw229-mood-ring").url),
                "mayco",
            )
        )
        assert (product.code, product.price_min, product.price_max) == ("SW-229", None, None)


class TestBadges:
    """Mayco states one fact three ways, and all three have to land on the same field."""

    def test_icon_url_values(self) -> None:
        badges = parse("sw-197-fossil-rock").badges
        assert badges.dinnerware_safe is False

    def test_plain_text_values(self) -> None:
        """25 products spell it out instead of linking an icon."""
        badges = parse("pb001-pure-brilliance-clear-brushing").badges
        assert (badges.dinnerware_safe, badges.food_safe) == (True, True)

    def test_a_raw_img_tag_value(self) -> None:
        """One product states it as a raw `<img src="...with-clear-glaze.png" />` tag."""
        badges = parse("ug-208-dragon-red").badges
        assert (badges.food_safe_under_glaze, badges.ap_seal) == (True, True)

    def test_with_clear_glaze_is_not_dinnerware_safe_outright(self) -> None:
        """84 products carry this. The claim is conditional, and `food_safe_under_glaze`
        is the field that says so; `dinnerware_safe` stays unstated because the page has
        not answered that about the bare glaze."""
        badges = parse("ug-236-grey").badges
        assert badges.food_safe_under_glaze is True
        assert badges.dinnerware_safe is None

    def test_the_acmi_seal_is_not_a_food_safety_claim(self) -> None:
        """AP means "non-toxic", not "safe to eat off".

        377 glazes carry it. Mapping it onto `food_safe` would put a safety claim Mayco
        never made on more than half the catalog, on the chip people read before deciding
        what to serve dinner on.
        """
        badges = parse("sc-104-grape-expectations").badges
        assert badges.ap_seal is True
        assert badges.food_safe is None

    def test_a_cautionary_seal_wins_over_a_conflicting_approval(self) -> None:
        """FN-219 carries the ACMI CL *and* AP seals at once, which cannot both be true.
        When a source contradicts itself about a safety property, keep the warning."""
        assert parse("fn-219-lustre-green").badges.ap_seal is False

    @pytest.mark.parametrize(
        ("value", "token"),
        [
            (
                "http://maycocolors.com/catalog/toxicology/not-dinnerware-safe.png",
                "not-dinnerware-safe",
            ),
            ('<img src="http://maycocolors.com/catalog/toxicology/ap-acmi.png" />', "ap-acmi"),
            ("Not Dinnerware Safe", "not-dinnerware-safe"),
            ("Dinnerware Safe with Clear Glaze", "dinnerware-safe-with-clear-glaze"),
            ("Food Safe", "food-safe"),
        ],
    )
    def test_all_three_spellings_reduce_to_one_token(self, value: str, token: str) -> None:
        """The icon basename and the slugified prose coincide exactly, which is what lets
        one vocabulary entry cover both."""
        assert _value_token(value) == token


class TestGallery:
    def test_images_are_full_size_originals(self) -> None:
        """`src`, never `thumbnail` or an entry from `srcset` — those are WordPress's
        generated crops, and colour-naming a 300x300 thumbnail instead of the photograph
        would be a silent quality loss."""
        images = parse("sw-197-fossil-rock").images
        assert images
        assert not any("-300x300" in str(i.source_url) for i in images)

    def test_alt_text_is_carried(self) -> None:
        """Mayco writes real alt text, which AMACO does not — its captions are burned into
        the pixels. It is a second evidence channel, so it must survive parsing."""
        images = parse("sw214-micro-pearl").images
        assert any(i.alt and "clay" in i.alt.lower() for i in images)

    def test_the_placeholder_image_is_dropped(self) -> None:
        """`image-coming-soon.jpg` is a picture of nothing and would colour-name as grey.

        No fired product carries it today — it appears on non-glaze SKUs — so this pins the
        guard directly rather than through a fixture that would stop testing it the moment
        Mayco photographs that product.
        """
        body = json.dumps(
            [
                {
                    "sku": "SW-999",
                    "name": "Placeholder",
                    "permalink": "https://www.maycocolors.com/product/sw999-x/",
                    "categories": [],
                    "prices": {"price": "100", "currency_minor_unit": 2},
                    "images": [
                        {"src": "https://www.maycocolors.com/wp-content/uploads/2020/09/image-coming-soon.jpg"},
                        {"src": "https://www.maycocolors.com/wp-content/uploads/2020/09/sw-999.jpg"},
                    ],
                }
            ]
        )
        product = parse_product(_synthetic_snapshot(body))
        assert [i.raw_filename for i in product.images] == ["sw-999.jpg"]


@pytest.mark.parametrize("slug", SLUGS)
def test_the_external_id_is_usable_as_a_slug(slug: str) -> None:
    """`Loader.upsert_glaze` binds `external_id` straight into `glazes.slug`.

    So an id carrying a path — `product/s-2709-cappuccino-mint` — puts a non-slug in a column
    named `slug`. Nothing in the app reads it today, which is exactly why this needs asserting
    rather than noticing: it would have reached 630 rows unremarked.
    """
    product = parse(slug)
    assert "/" not in product.external_id
    # And it round-trips: the id is precisely what product_ref accepts, the invariant AMACO
    # already has.
    assert ADAPTER.product_ref(product.external_id).external_id == product.external_id


def _synthetic_snapshot(body: str) -> RawSnapshot:
    """A snapshot for a payload no fixture holds, so a guard can be pinned directly."""
    return RawSnapshot(
        url=str(ADAPTER.product_ref("sw999-x").url),
        fetched_at=datetime(2026, 7, 30, tzinfo=UTC),
        http_status=200,
        body=body,
        content_hash=hashlib.sha256(body.encode()).hexdigest(),
    )


class TestUrlIdentity:
    """Mayco reads one product through two URLs, and the id has to name the product."""

    def test_product_ref_targets_the_store_api(self) -> None:
        ref = ADAPTER.product_ref("sw-197-fossil-rock")
        assert str(ref.url) == (
            "https://www.maycocolors.com/wp-json/wc/store/v1/products?slug=sw-197-fossil-rock"
        )
        assert ref.external_id == "sw-197-fossil-rock"

    @pytest.mark.parametrize(
        "url",
        [
            "https://www.maycocolors.com/wp-json/wc/store/v1/products?slug=sw-197-fossil-rock",
            "https://www.maycocolors.com/product/sw-197-fossil-rock/",
            "https://www.maycocolors.com/product/sw-197-fossil-rock",
        ],
    )
    def test_external_id_is_the_same_from_either_shape(self, url: str) -> None:
        """The API endpoint is how we read the bytes; the permalink is what the product is.
        F4 exists because two copies of this logic once disagreed.

        Bare slug, not the `product/…` path: `Loader.upsert_glaze` binds this to
        `glazes.slug`, and it is also what `product_ref` accepts — the same invariant AMACO
        has."""
        assert ADAPTER.external_id_for(url) == "sw-197-fossil-rock"

    def test_round_trip(self) -> None:
        ref = ADAPTER.product_ref("cg-999-jazz-notes")
        assert ADAPTER.external_id_for(str(ref.url)) == ref.external_id

    def test_stray_slashes_are_tolerated(self) -> None:
        assert slug_from("/product/lilac/") == "lilac"
        assert ADAPTER.product_ref("/lilac/").external_id == "lilac"

    def test_the_parsed_product_url_is_the_human_page(self) -> None:
        """Attribution links out to this, so it must not be the API endpoint."""
        product = parse("sw-197-fossil-rock")
        assert str(product.product_url) == (
            "https://www.maycocolors.com/product/sw-197-fossil-rock/"
        )
        assert product.external_id == "sw-197-fossil-rock"


class TestDiscovery:
    def test_the_sitemap_carries_lastmod(self) -> None:
        """The delta signal AMACO's sitemap does not have, and the reason `since` stops
        being vestigial for this source. If this ever fails, Yoast changed and
        `discover(since=…)` silently reverts to fetching everything."""
        refs = parse_sitemap((FIXTURES / "sitemap-products-1.xml").read_text())
        assert len(refs) > 900
        assert all(r.lastmod is not None for r in refs)

    def test_the_shop_archive_page_is_not_a_product(self) -> None:
        """The product sitemap opens with `/shop/`, which is a listing page."""
        refs = parse_sitemap((FIXTURES / "sitemap-products-1.xml").read_text())
        assert all("/product/" in str(r.url) for r in refs)

    def test_the_allowlist_keeps_glazes(self) -> None:
        slugs = parse_allowlist((FIXTURES / "fired-allowlist-page-1.json").read_text())
        assert slugs
        assert "sw229-mood-ring" in slugs

    def test_a_kit_is_not_a_glaze(self) -> None:
        """21 assortment kits sit inside `fired` and are not glazes — they are also exactly
        the products with no cone statement."""
        kit = json.loads((FIXTURES / "nonglaze-sp-kt2p-kit.json").read_text())[0]
        assert is_glaze(kit["categories"]) is False

    def test_the_filter_fails_closed(self) -> None:
        """A product whose categories we cannot read is not a glaze."""
        assert is_glaze([]) is False
        assert is_glaze(
            [{"slug": "tools", "link": "https://www.maycocolors.com/product-category/tools/"}]
        ) is False

    def test_fired_alone_is_enough(self) -> None:
        assert is_glaze(
            [
                {"slug": "color", "link": "https://www.maycocolors.com/product-category/color/"},
                {
                    "slug": "fired",
                    "link": "https://www.maycocolors.com/product-category/color/fired/",
                },
            ]
        ) is True

    def test_a_product_deep_in_the_branch_counts(self) -> None:
        """Worth 32 glazes. Bead and Melt Gloop sit in `color/fired/ritual-glazes/bead/` and
        their category array never lists the intermediate `fired` — only `bead`,
        `ritual-glazes` and `new-colors`. Requiring the `fired` slug fetched them into the
        allowlist query (Woo returns descendants for ?category=98) and then discarded them."""
        assert is_glaze(
            [
                {
                    "slug": "bead",
                    "link": "https://www.maycocolors.com/product-category/color/fired/"
                    "ritual-glazes/bead/",
                },
                {
                    "slug": "new-colors",
                    "link": "https://www.maycocolors.com/product-category/color/new-colors/",
                },
            ]
        ) is True

    def test_a_sibling_branch_does_not_count(self) -> None:
        """`non-fired` is a different child of `color`, and its path must not match."""
        assert is_glaze(
            [
                {
                    "slug": "softees-acrylics",
                    "link": "https://www.maycocolors.com/product-category/color/non-fired/"
                    "softees-acrylics/",
                }
            ]
        ) is False


class TestGrammar:
    @pytest.mark.parametrize(
        ("filename", "role", "subject", "over", "cone"),
        [
            ("SW214.jpg", ImageRole.LABEL_CHIP, "SW-214", None, None),
            ("sw214_cone10.jpg", ImageRole.LABEL_CHIP, "SW-214", None, "10"),
            ("ug-236_cone6.jpg", ImageRole.LABEL_CHIP, "UG-236", None, "6"),
            # One-letter prefix. 21 fired SKUs have one — the whole S-27xx Jungle Gems block
            # and C-300 — and requiring two letters classified every one of their swatches as
            # OTHER, because no code matched at all. data_quality.sql caught it on the first
            # real load; this is the cheaper place to catch it again.
            ("s-2712.jpg", ImageRole.LABEL_CHIP, "S-2712", None, None),
            ("s-2712_cone6.jpg", ImageRole.LABEL_CHIP, "S-2712", None, "6"),
            ("c-300_cone06.jpg", ImageRole.LABEL_CHIP, "C-300", None, "06"),
            # `over` between exactly two codes is the one shape that resolves to a pair.
            ("sw250_over_sw401_cone6.jpg", ImageRole.LAYERED, "SW-250", "SW-401", "6"),
            # The cone sometimes sits inside the gap. Four filenames do this, and all four
            # would lose their layering if the gap had to be a bare `over`.
            ("fd258_cone10_over_sw508.jpg", ImageRole.LAYERED, "FD-258", "SW-508", "10"),
        ],
    )
    def test_filename_facts(
        self, filename: str, role: ImageRole, subject: str, over: str | None, cone: str | None
    ) -> None:
        facts = interpret_filename(filename, subject)
        assert (facts.role, facts.subject_code, facts.layered_over_code, facts.cone) == (
            role,
            subject,
            over,
            cone,
        )

    def test_under_inverts_the_pair(self) -> None:
        """`sw214_under_sw401` is SW-401 sitting on top of SW-214.

        `under` is more common than `over` in this catalog (186 tokens to 119), and the
        relation `layered_over_code` models is directional. Recording it as
        "SW-214 over SW-401" would write an inverted layering into the database, because
        `link_layering` trusts this field.
        """
        # Read from SW-401's page, where SW-401 is the top glaze, so the pair is expressible.
        facts = interpret_filename("sw214_under_sw401_cone6.jpg", "SW-401")
        assert (facts.subject_code, facts.layered_over_code) == ("SW-401", "SW-214")
        assert facts.evidence["layering_direction"] == "under"

    def test_the_base_glaze_is_not_layered_over_itself(self) -> None:
        """The same image is on both glazes' pages, and the pair means something in only one
        direction.

        `layered_over_code` describes the glaze the appearance is attached to, which is
        whichever page the image was found on. So on SW-119's page `sw401_over_sw119` must not
        claim SW-119 sits on SW-119. Measured before this guard existed: 3 of Mayco's 9
        layering links were self-referential, and 59 of AMACO's 130 — 45% of the data.
        """
        facts = interpret_filename("sw401_over_sw119_crop.jpg", "SW-119")
        assert facts.layered_over_code is None
        assert facts.evidence["layered_under"] == "SW-401"
        # ...and the same image on the top glaze's page still records the pair.
        assert interpret_filename("sw401_over_sw119_crop.jpg", "SW-401").layered_over_code == (
            "SW-119"
        )

    def test_under_on_the_base_glazes_own_page_is_also_refused(self) -> None:
        """Mayco publishes `sw401_over_sw119` and `sw401_under_sw119` on the same product, so
        both directions occur for one glaze. On SW-401's page the `under` frame makes SW-401
        the base."""
        facts = interpret_filename("sw401_under_sw119_crop.jpg", "SW-401")
        assert facts.layered_over_code is None
        assert facts.evidence["layered_under"] == "SW-119"

    def test_three_codes_are_a_combination_not_a_pair(self) -> None:
        """`sw214_over_sw401_sw402` is one frame showing the glaze over two fluxes, which
        `layered_over_glaze_id` cannot model. Recorded whole rather than narrowed to
        whichever pair happens to read first."""
        facts = interpret_filename("sw214_over_sw401_sw402_cone6_web.jpg", "SW-214")
        assert facts.layered_over_code is None
        assert facts.combination_codes == ("SW-214", "SW-401", "SW-402")
        assert facts.confidence is Confidence.LOW

    def test_a_coats_composite_is_recorded_but_never_split(self) -> None:
        """Mayco's composites hold four tiles, captioned by brush-coat count.

        Not `COATS_COMPOSITE`: the splitter refuses anything but three and its
        white-background detector is tuned to AMACO's layout, and `CoatLevel` is AMACO's
        four thickness *words*. Whether counts and thicknesses are one axis is the F8
        decision. The image is still a real appearance meanwhile, and the count is kept so
        that decision has data.
        """
        facts = interpret_filename("sw214_1234coats_cone5_web.jpg", "SW-214")
        assert facts.role is not ImageRole.COATS_COMPOSITE
        assert facts.coat_level is None
        assert facts.evidence["coats_unsplit"] == "1234coats"

    def test_the_adapter_declares_no_coat_order(self) -> None:
        """The pipeline raises if regions arrive without a `coat_order` to map them, so an
        empty tuple and a grammar that never emits COATS_COMPOSITE have to agree."""
        assert ADAPTER.coat_order == ()

    def test_whole_line_imagery_is_excluded(self) -> None:
        """`2024_SW_lineup_clay-body-bowls_1_IGtall.jpg` is shared by 11 Stoneware products
        and its alt describes the clay, not a glaze. As LINE_CHART it becomes no
        appearance at all, rather than giving eleven glazes one hero colour."""
        facts = interpret_filename(
            "2024_SW_lineup_clay-body-bowls_1_IGtall.jpg", "SW-214", "White Clay, cone 6 oxidation"
        )
        assert facts.role is ImageRole.LINE_CHART

    def test_cone_falls_back_to_alt_text(self) -> None:
        """Stated in the alt and nowhere in the filename. AMACO could never do this."""
        facts = interpret_filename("2024_SW_bowls_1.jpg", "SW-214", "White Clay, cone 6 oxidation")
        assert facts.cone == "6"
        assert facts.evidence["cone_from_alt"] == "cone 6"

    def test_a_form_word_reads_as_in_use(self) -> None:
        facts = interpret_filename("sw-104_mug_web.jpg", "SW-104")
        assert (facts.role, facts.form) == (ImageRole.IN_USE, FormKind.MUG)

    def test_wordpress_suffixes_do_not_become_tokens(self) -> None:
        """`-scaled` and `-300x300` are stripped from the *stem* only. The URL keeps them,
        because for an image WordPress re-encoded above 2560px the `-scaled` file is the
        real one and a stripped URL would 404."""
        assert interpret_filename("el-212-scaled.jpg", "EL-212").subject_code == "EL-212"
        assert interpret_filename("el-212-300x300.jpg", "EL-212").unmatched_tokens == ()

    def test_atmosphere_is_reported_rather_than_swallowed(self) -> None:
        """Kiln atmosphere is stated and there is nowhere to put it — no field on
        ImageFacts, no column on appearances. 92 filenames say `reduction` and 48 say
        `soda`, so it surfaces as unresolved instead of being dropped silently."""
        facts = interpret_filename("sw214_soda_web.jpg", "SW-214")
        assert "soda" in facts.unmatched_tokens

    def test_a_filename_that_names_no_code_is_not_high_confidence(self) -> None:
        """`subject_code` falls back to the product whose page the image was on, so a
        filename of pure noise still gets one. Calling that HIGH would claim the filename
        identified the glaze when it said nothing — and data_quality.sql trusts this field.
        """
        facts = interpret_filename("web_crop.jpg", "SW-214")
        assert facts.subject_code == "SW-214"
        assert facts.confidence is Confidence.MEDIUM

    def test_a_recognized_word_is_not_reported_as_unmatched(self) -> None:
        """`unmatched_tokens` means "a rule failed here". A word the grammar read correctly
        belongs in evidence, not in the review queue."""
        facts = interpret_filename("sw-104_mug_web.jpg", "SW-104")
        assert facts.unmatched_tokens == ()
        assert facts.evidence["form"] == "mug"


class TestTextCleaning:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("<p><strong>Cone 6:</strong> Glossy.</p>", "Cone 6: Glossy."),
            ("Stroke &amp; Coat&reg;", "Stroke & Coat®"),
            ("a\xa0b", "a b"),
            ("  spread   out  ", "spread out"),
        ],
    )
    def test_clean_text(self, raw: str, expected: str) -> None:
        assert clean_text(raw) == expected

    @pytest.mark.parametrize("slug", SLUGS)
    def test_no_fixture_leaks_markup_or_an_entity(self, slug: str) -> None:
        product = parse(slug)
        for field in (product.name, product.description, product.line_name):
            if field:
                assert "<" not in field
                assert "&amp;" not in field and "&nbsp;" not in field


def test_the_registry_resolves_mayco() -> None:
    assert isinstance(adapter_for("mayco"), MaycoAdapter)

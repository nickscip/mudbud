"""`discover()` for both adapters, driven through httpx.MockTransport — no network.

Every client is created here and closed here: an adapter left to build its own would
reach the real site, and an unclosed one raises a ResourceWarning, which this suite
turns into a failure (`filterwarnings = ["error"]`).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest

from glaze_etl.sources.amaco.adapter import AmacoAdapter
from glaze_etl.sources.amaco.adapter import parse_sitemap as amaco_parse_sitemap
from glaze_etl.sources.mayco.adapter import _ALLOWLIST_PAGE_SIZE, MaycoAdapter
from glaze_etl.sources.mayco.adapter import parse_sitemap as mayco_parse_sitemap
from glaze_etl.sources.mayco.urls import PRODUCT_API_URL, SITE
from glaze_etl.sources.mayco.vocabulary import FIRED_CATEGORY_ID, FIRED_PATH
from tests.conftest import fixture_dir

Routes = dict[str, httpx.Response]

AMACO_SITEMAP = (fixture_dir("amaco") / "sitemap-products-1.xml").read_text()
"""954 URLs, 352 of them glaze slugs — the rest are kilns, elements and spare parts."""

MAYCO_INDEX = (fixture_dir("mayco") / "sitemap-index.xml").read_text()
MAYCO_SITEMAP_1 = (fixture_dir("mayco") / "sitemap-products-1.xml").read_text()
MAYCO_SITEMAP_2 = (fixture_dir("mayco") / "sitemap-products-2.xml").read_text()
MAYCO_ALLOWLIST = (fixture_dir("mayco") / "fired-allowlist-page-1.json").read_text()
"""20 Store API products, 19 of which pass `is_glaze` — short of a full page, so the
allowlist walk stops after one request."""


def router(routes: Routes) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    """Dispatch on `path`, or `path?page=N` when the request carries a page param.

    Anything unrouted answers 404, which is what both walks read as the end of the list.
    """
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        page = request.url.params.get("page")
        key = f"{request.url.path}?page={page}" if page else request.url.path
        response = routes.get(key, routes.get(request.url.path))
        return response if response is not None else httpx.Response(404)

    return httpx.MockTransport(handle), seen


async def discover(
    adapter_cls: type[AmacoAdapter] | type[MaycoAdapter],
    routes: Routes,
    since: datetime | None = None,
) -> tuple[list[str], list[httpx.Request]]:
    """Drain `discover()` to (external ids, requests made)."""
    transport, seen = router(routes)
    async with httpx.AsyncClient(transport=transport) as client:
        adapter = adapter_cls(client=client)
        return [ref.external_id async for ref in adapter.discover(since)], seen


# --- AMACO ---------------------------------------------------------------------------

SITEMAP_PATH = "/xmlsitemap.php"

SITEMAP_PAGE_2 = """<urlset>
  <url><loc>https://shop.amaco.com/sm-02-stone/</loc></url>
  <url><loc>https://shop.amaco.com/element-coil-for-kiln-no-67-e-110v/</loc></url>
</urlset>"""


class TestAmacoDiscover:
    async def test_walks_pages_until_a_404_and_yields_glazes_only(self) -> None:
        ids, seen = await discover(
            AmacoAdapter,
            {
                f"{SITEMAP_PATH}?page=1": httpx.Response(200, text=AMACO_SITEMAP),
                f"{SITEMAP_PATH}?page=2": httpx.Response(200, text=SITEMAP_PAGE_2),
            },
        )

        assert len(seen) == 3, "page 3 must be requested, and its 404 ends the walk"
        assert len(ids) == 353, "352 glazes on page 1, one on page 2"
        assert ids[-1] == "sm-02-stone"
        assert "element-coil-for-kiln-no-67-e-110v" not in ids

    async def test_an_empty_urlset_also_ends_the_walk(self) -> None:
        ids, seen = await discover(
            AmacoAdapter,
            {
                f"{SITEMAP_PATH}?page=1": httpx.Response(200, text=AMACO_SITEMAP),
                f"{SITEMAP_PATH}?page=2": httpx.Response(200, text="<urlset></urlset>"),
            },
        )

        assert len(seen) == 2, "no page 3 after an empty one"
        assert len(ids) == 352

    async def test_since_drops_entries_at_or_before_it(self) -> None:
        """Vestigial against the live sitemap, which carries no `lastmod` — asserted here
        so it stays honest if AMACO ever starts emitting one."""
        xml = """<urlset>
          <url><loc>https://shop.amaco.com/pc-20-blue-rutile/</loc>
               <lastmod>2026-01-01T00:00:00Z</lastmod></url>
          <url><loc>https://shop.amaco.com/pc-30-temmoku/</loc>
               <lastmod>2026-06-01T00:00:00Z</lastmod></url>
          <url><loc>https://shop.amaco.com/pc-45-dark-green/</loc>
               <lastmod>2026-09-01T00:00:00Z</lastmod></url>
        </urlset>"""
        ids, _ = await discover(
            AmacoAdapter,
            {f"{SITEMAP_PATH}?page=1": httpx.Response(200, text=xml)},
            since=datetime(2026, 6, 1, tzinfo=UTC),
        )

        assert ids == ["pc-45-dark-green"], "equal lastmod counts as unchanged"

    async def test_a_server_error_is_raised_not_swallowed(self) -> None:
        with pytest.raises(httpx.HTTPStatusError):
            await discover(AmacoAdapter, {f"{SITEMAP_PATH}?page=1": httpx.Response(500)})

    def test_parse_sitemap_tolerates_broken_entries(self) -> None:
        refs = amaco_parse_sitemap("""<urlset>
          <url><lastmod>2026-01-01T00:00:00Z</lastmod></url>
          <url><loc></loc></url>
          <url><loc>https://shop.amaco.com/pc-20-blue-rutile/</loc>
               <lastmod>whenever</lastmod></url>
          <url><loc>https://shop.amaco.com/pc-30-temmoku/</loc>
               <lastmod>2026-02-03T04:05:06Z</lastmod></url>
        </urlset>""")

        assert [r.external_id for r in refs] == ["pc-20-blue-rutile", "pc-30-temmoku"]
        assert refs[0].lastmod is None, "an unparseable lastmod must not drop the product"
        assert refs[1].lastmod == datetime(2026, 2, 3, 4, 5, 6, tzinfo=UTC)


# --- Mayco ---------------------------------------------------------------------------

PRODUCTS_PATH = "/wp-json/wc/store/v1/products"


def allowlist(*slugs: str) -> str:
    """A Store API page carrying the only two fields `is_glaze` reads."""
    return json.dumps(
        [
            {"slug": slug, "categories": [{"slug": "fired", "link": f"{SITE}{FIRED_PATH}"}]}
            for slug in slugs
        ]
    )


def mayco_routes(overrides: Routes | None = None) -> Routes:
    """The four requests a clean run makes, keyed so a test can replace one.

    Every case needs all four: `discover` fetches the sitemaps whatever the allowlist
    did, so an unrouted index would raise instead of showing the behaviour under test.
    """
    routes: Routes = {
        f"{PRODUCTS_PATH}?page=1": httpx.Response(200, text=MAYCO_ALLOWLIST),
        "/sitemap_index.xml": httpx.Response(200, text=MAYCO_INDEX),
        "/product-sitemap.xml": httpx.Response(200, text=MAYCO_SITEMAP_1),
        "/product-sitemap2.xml": httpx.Response(200, text=MAYCO_SITEMAP_2),
    }
    return routes | (overrides or {})


async def product_sitemaps(index_xml: str) -> list[str]:
    transport, _ = router({"/sitemap_index.xml": httpx.Response(200, text=index_xml)})
    async with httpx.AsyncClient(transport=transport) as client:
        return await MaycoAdapter(client=client)._product_sitemaps(client)


class TestMaycoDiscover:
    async def test_yields_the_allowlist_and_sitemap_intersection(self) -> None:
        transport, seen = router(mayco_routes())
        async with httpx.AsyncClient(transport=transport) as client:
            refs = [ref async for ref in MaycoAdapter(client=client).discover()]

        assert len(seen) == 4, "one allowlist page, the index, both product sitemaps"
        assert seen[0].url.path == PRODUCTS_PATH
        assert seen[0].url.params["category"] == str(FIRED_CATEGORY_ID)
        assert seen[0].url.params["per_page"] == str(_ALLOWLIST_PAGE_SIZE)
        assert seen[0].url.params["page"] == "1"

        assert len(refs) == 19, "the 19 glazes of the allowlist page, across both sitemaps"
        assert len({r.external_id for r in refs}) == 19, "the two sitemaps must not overlap"
        assert all(str(r.url) == PRODUCT_API_URL.format(slug=r.external_id) for r in refs), (
            "the stored URL is the Store API endpoint, not the sitemap permalink"
        )
        by_id = {r.external_id: r for r in refs}
        assert by_id["sw225-lily-pad"].lastmod == datetime(2026, 4, 20, 15, 53, 21, tzinfo=UTC)

    async def test_the_allowlist_pages_until_a_short_page(self) -> None:
        full = allowlist("sw225-lily-pad", *(f"filler-{i}" for i in range(99)))
        assert len(json.loads(full)) == _ALLOWLIST_PAGE_SIZE
        ids, seen = await discover(
            MaycoAdapter,
            mayco_routes(
                {
                    f"{PRODUCTS_PATH}?page=1": httpx.Response(200, text=full),
                    f"{PRODUCTS_PATH}?page=2": httpx.Response(
                        200, text=allowlist("sw226-pink-pearl")
                    ),
                }
            ),
        )

        assert [r.url.params["page"] for r in seen if r.url.path == PRODUCTS_PATH] == ["1", "2"]
        assert sorted(ids) == ["sw225-lily-pad", "sw226-pink-pearl"]

    @pytest.mark.parametrize("status", [400, 404])
    async def test_an_error_after_the_first_page_ends_the_walk(self, status: int) -> None:
        """WordPress answers 400 `rest_post_invalid_page_number` for the page after the
        last, which is what a catalog that is an exact multiple of the page size hits."""
        full = allowlist("sw225-lily-pad", *(f"filler-{i}" for i in range(99)))
        ids, _ = await discover(
            MaycoAdapter,
            mayco_routes(
                {
                    f"{PRODUCTS_PATH}?page=1": httpx.Response(200, text=full),
                    f"{PRODUCTS_PATH}?page=2": httpx.Response(
                        status, json={"code": "rest_post_invalid_page_number"}
                    ),
                }
            ),
        )

        assert ids == ["sw225-lily-pad"]

    @pytest.mark.parametrize(
        "body", ['{"code": "rest_no_route"}', "[]"], ids=["not-a-list", "empty"]
    )
    async def test_an_unusable_first_page_yields_nothing(self, body: str) -> None:
        ids, _ = await discover(
            MaycoAdapter,
            mayco_routes({f"{PRODUCTS_PATH}?page=1": httpx.Response(200, text=body)}),
        )

        assert ids == []

    async def test_since_drops_entries_at_or_before_it(self) -> None:
        """The sitemap is the only source of `lastmod` — the Store API payload has none."""
        routes = mayco_routes(
            {
                f"{PRODUCTS_PATH}?page=1": httpx.Response(
                    200, text=allowlist("sw232-baby-blue-speck", "sw225-lily-pad")
                )
            }
        )
        ids, _ = await discover(MaycoAdapter, routes, since=datetime(2026, 4, 1, tzinfo=UTC))

        assert ids == ["sw225-lily-pad"], "sw232's 2026-03-30 lastmod predates `since`"

    async def test_only_product_sitemaps_are_followed(self) -> None:
        found = await product_sitemaps(MAYCO_INDEX)

        assert found == [
            f"{SITE}/product-sitemap.xml",
            f"{SITE}/product-sitemap2.xml",
        ], "glazecombo/project/color_swatch sitemaps are real evidence we do not handle yet"

    async def test_an_index_without_product_sitemaps_raises(self) -> None:
        index = f"""<sitemapindex>
          <sitemap><loc>{SITE}/glazecombo-sitemap.xml</loc></sitemap>
          <sitemap><loc></loc></sitemap>
        </sitemapindex>"""
        with pytest.raises(ValueError, match="no product sitemaps"):
            await product_sitemaps(index)

    def test_parse_sitemap_skips_everything_that_is_not_a_product(self) -> None:
        refs = mayco_parse_sitemap(f"""<urlset>
          <url><loc>{SITE}/shop/</loc><lastmod>2026-01-01T00:00:00Z</lastmod></url>
          <url><lastmod>2026-01-01T00:00:00Z</lastmod></url>
          <url><loc></loc></url>
          <url><loc>{SITE}/product/sw225-lily-pad/</loc><lastmod>whenever</lastmod></url>
          <url><loc>{SITE}/product/sw227-tidal-wave/</loc></url>
          <url><loc>{SITE}/product/sw226-pink-pearl/</loc>
               <lastmod>2026-02-03T04:05:06Z</lastmod></url>
        </urlset>""")

        assert [r.external_id for r in refs] == [
            "sw225-lily-pad",
            "sw227-tidal-wave",
            "sw226-pink-pearl",
        ]
        assert refs[0].lastmod is None, "an unparseable lastmod must not drop the product"
        assert refs[1].lastmod is None
        assert refs[2].lastmod == datetime(2026, 2, 3, 4, 5, 6, tzinfo=UTC)

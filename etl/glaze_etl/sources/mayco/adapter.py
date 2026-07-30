"""Mayco — maycocolors.com. WooCommerce, and the source that proves the seam works."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import datetime
from urllib.parse import parse_qs, urlsplit

import httpx
from selectolax.parser import HTMLParser

from glaze_etl.core.models import (
    ImageFacts,
    ManufacturerKey,
    ParsedImage,
    ParsedProduct,
    Politeness,
    ProductRef,
    RawSnapshot,
)
from glaze_etl.core.source_adapter import SourceAdapter
from glaze_etl.sources.mayco.filename_grammar import interpret_filename
from glaze_etl.sources.mayco.parser import parse_product
from glaze_etl.sources.mayco.vocabulary import (
    CATEGORY_CONE_RANGE,
    EXCLUDED_CATEGORIES,
    FIRED_CATEGORY_ID,
)

SITE = "https://www.maycocolors.com"
SITEMAP_INDEX_URL = f"{SITE}/sitemap_index.xml"
PRODUCTS_API = f"{SITE}/wp-json/wc/store/v1/products"
PRODUCT_API_URL = f"{PRODUCTS_API}?slug={{slug}}"

USER_AGENT = (
    "mudbud-glaze-etl/0.1 (+https://github.com/nickscip/mudbud) "
    "contact: nscipione@blendlabsinc.com"
)

_ALLOWLIST_PAGE_SIZE = 100
"""The Store API's own maximum. Seven requests cover the 651 fired products."""


def _external_id(slug: str) -> str:
    """The permalink path, which is the product's identity on this site.

    Not the API URL the bytes came from: `?slug=sw-197-fossil-rock` and
    `/product/sw-197-fossil-rock/` are two ways to read one product, and the id has to
    name the product. F4 exists because two copies of this logic once disagreed about
    whether the id was a whole path or its last segment, so there is one copy.
    """
    return f"product/{slug.strip('/')}"


def slug_from(url: str) -> str:
    """Recover the slug from either shape of Mayco product URL."""
    parts = urlsplit(url)
    if slugs := parse_qs(parts.query).get("slug"):
        return slugs[0].strip("/")
    return parts.path.strip("/").removeprefix("product/").strip("/")


def is_glaze(categories: list[dict[str, object]]) -> bool:
    """A product is a glaze if Mayco files it under `color/fired` and not as a kit.

    This is the whole non-glaze filter, and it is evidence rather than inference: the
    category tree separates fired colour from acrylics, bisque forms, brushes and wax
    resist, and a chip chart or a kit is excluded by name. Contrast AMACO, where the only
    available signal was the shape of the slug.

    Fails closed. A product whose categories we cannot read is not a glaze.
    """
    slugs = {str(c.get("slug") or "") for c in categories}
    return "fired" in slugs and not (slugs & EXCLUDED_CATEGORIES)


class MaycoAdapter(SourceAdapter):
    manufacturer = ManufacturerKey.MAYCO
    politeness = Politeness(crawl_delay_s=10.0, user_agent=USER_AGENT)
    # Mayco's robots.txt permits all of this and declares **no** Crawl-delay — the Yoast
    # block is an empty `Disallow:` and /wp-json/ is not listed — so nothing is imposed on
    # us and the delay is a choice (F14). 10s mirrors what AMACO's robots.txt asks for,
    # on the grounds that a site that has not told us its budget should not be treated
    # more roughly than one that has. At ~630 glazes that makes a full pass ~1.75 hours,
    # which the weekly cron absorbs. It is the only lever: the Fetcher is strictly serial.

    coat_order = ()
    """Empty, so nothing is ever split, and now for a measured reason rather than caution.
    Mayco's composites hold **four** tiles captioned by brush-coat count
    (`sw214_1234coats_cone6_web.jpg`, alt "1, 2, 3, 4 coats"), while the splitter refuses
    anything that is not exactly three and its white-background detector is tuned to
    AMACO's layout. `CoatLevel` is also AMACO's four thickness words, and
    `coat_levels.ordinal` is globally unique — so mapping counts onto it is the F8 decision,
    not an implementation detail. Those images still become appearances; they just arrive
    whole, with the coat count kept in evidence."""

    volatile_patterns = ()
    """Nothing to strip, measured rather than assumed. The same product fetched twice ten
    seconds apart came back byte-for-byte identical (`volatile-sw-197-fossil-rock-fetch-a`
    and `-b` in the fixtures, pinned by a test). A JSON API has no nonce, no analytics blob
    and no cache-buster to inject, which is the one way it is quieter than BigCommerce."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def discover(self, since: datetime | None = None) -> AsyncIterator[ProductRef]:
        """Enumerate glaze products, hybrid: the API says *which*, the sitemap says *when*.

        Neither source alone is enough. The Store API's category filter is the only exact
        glaze filter Mayco offers, but its product payload carries no modified date. The
        Yoast sitemap carries `lastmod` on every entry — the delta signal AMACO's sitemap
        lacks entirely, and the reason `since` stops being vestigial here — but says nothing
        about what a product *is*. So the API supplies the allowlist and the sitemap
        supplies the timestamps. Nine requests, and both properties survive.

        Verified before relying on it: all 651 fired products appear in the product
        sitemaps, so nothing is lost by taking URLs from there.
        """
        client = self._client or httpx.AsyncClient(
            headers={"User-Agent": self.politeness.user_agent}, timeout=45.0
        )
        allowed = await self._glaze_slugs(client)
        for sitemap_url in await self._product_sitemaps(client):
            response = await client.get(sitemap_url)
            response.raise_for_status()
            for ref in parse_sitemap(response.text):
                slug = slug_from(str(ref.url))
                if slug not in allowed:
                    continue
                if since and ref.lastmod and ref.lastmod <= since:
                    continue
                yield self.product_ref(slug).model_copy(update={"lastmod": ref.lastmod})

    async def _glaze_slugs(self, client: httpx.AsyncClient) -> set[str]:
        """Page the Store API's `fired` category into the set of slugs worth fetching."""
        slugs: set[str] = set()
        page = 1
        while True:
            response = await client.get(
                PRODUCTS_API,
                params={
                    "category": FIRED_CATEGORY_ID,
                    "per_page": _ALLOWLIST_PAGE_SIZE,
                    "page": page,
                },
            )
            response.raise_for_status()
            products = response.json()
            if not isinstance(products, list) or not products:
                return slugs
            slugs |= _glaze_slugs_in(products)
            if len(products) < _ALLOWLIST_PAGE_SIZE:
                return slugs
            page += 1

    async def _product_sitemaps(self, client: httpx.AsyncClient) -> list[str]:
        """The `product-sitemap*.xml` entries of the sitemap index, and only those.

        Selected positively. Mayco also publishes `glazecombo-sitemap*.xml` (F15) and
        `project-`/`color_swatch-` sitemaps (F16), which are real appearance evidence we do
        not handle yet; an exclusion list would quietly start ingesting the next content
        type Mayco adds.
        """
        response = await client.get(SITEMAP_INDEX_URL)
        response.raise_for_status()
        tree = HTMLParser(response.text)
        found = [
            url
            for node in tree.css("sitemap")
            if (loc := node.css_first("loc")) and (url := loc.text().strip())
            if "/product-sitemap" in url
        ]
        if not found:
            raise ValueError(f"no product sitemaps in {SITEMAP_INDEX_URL}")
        return found

    def parse(self, snap: RawSnapshot) -> ParsedProduct:
        return parse_product(snap)

    def interpret_image(self, img: ParsedImage, ctx: ParsedProduct) -> ImageFacts:
        return interpret_filename(img.raw_filename, ctx.code, img.alt)

    def product_ref(self, slug: str) -> ProductRef:
        clean = slug_from(slug)
        return ProductRef(url=PRODUCT_API_URL.format(slug=clean), external_id=_external_id(clean))

    def external_id_for(self, url: str) -> str:
        return _external_id(slug_from(url))

    def cone_range_for_category(self, category: str) -> tuple[str, str] | None:
        return CATEGORY_CONE_RANGE.get(category)


def parse_sitemap(xml: str) -> list[ProductRef]:
    """Read `<url><loc>/<lastmod>` pairs out of a Yoast product sitemap.

    The `<loc>` values are permalinks, so the refs returned here are *not* what the
    Fetcher will be given — `discover` rebuilds each through `product_ref` so the stored
    URL is the API endpoint the parser can read. These carry the timestamps.
    """
    tree = HTMLParser(xml)
    refs: list[ProductRef] = []
    for node in tree.css("url"):
        loc = node.css_first("loc")
        if loc is None or not (url := loc.text().strip()):
            continue
        if "/product/" not in url:
            continue  # The sitemap opens with the /shop/ archive page.
        lastmod: datetime | None = None
        if (node_mod := node.css_first("lastmod")) and (raw := node_mod.text().strip()):
            try:
                lastmod = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                lastmod = None
        refs.append(ProductRef(url=url, external_id=_external_id(slug_from(url)), lastmod=lastmod))
    return refs


def _glaze_slugs_in(products: list[object]) -> set[str]:
    return {
        str(p["slug"])
        for p in products
        if isinstance(p, dict)
        and p.get("slug")
        and is_glaze(list(p.get("categories") or []))
    }


def parse_allowlist(body: str) -> set[str]:
    """The glaze slugs in one Store API category page. Split out so it is testable offline."""
    return _glaze_slugs_in(json.loads(body))


__all__ = [
    "MaycoAdapter",
    "is_glaze",
    "parse_allowlist",
    "parse_sitemap",
    "slug_from",
]

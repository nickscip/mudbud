"""AMACO — American Art Clay Co. The first and reference implementation."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from datetime import datetime
from urllib.parse import urlsplit

import httpx
from selectolax.parser import HTMLParser

from glaze_etl.core.models import (
    CoatLevel,
    ImageFacts,
    ManufacturerKey,
    ParsedImage,
    ParsedProduct,
    Politeness,
    ProductRef,
    RawSnapshot,
)
from glaze_etl.core.source_adapter import SourceAdapter
from glaze_etl.sources.amaco.filename_grammar import interpret_filename
from glaze_etl.sources.amaco.parser import parse_product
from glaze_etl.sources.amaco.vocabulary import CATEGORY_CONE_RANGE, GLAZE_LINE_CODES

SITEMAP_URL = "https://shop.amaco.com/xmlsitemap.php?type=products&page={page}"

PRODUCT_URL = "https://shop.amaco.com/{slug}/"


def _external_id(url: str) -> str:
    """AMACO's stable key is the whole URL path — a single slug segment."""
    return urlsplit(url).path.strip("/")

_GLAZE_SLUG_RE = re.compile(
    rf"^({'|'.join(c.lower() for c in GLAZE_LINE_CODES)})-\d{{1,3}}(-|$)",
)
"""AMACO's catalog is ~954 products, but most are kilns, wheels and spare parts.
Glaze SKUs are the ones whose slug opens with a known line code and a number, which
keeps `Elem_1_or_3_PH_208`-style equipment out of the pipeline entirely."""

USER_AGENT = (
    "mudbud-glaze-etl/0.1 (+https://github.com/nickscip/mudbud) "
    "contact: nscipione@blendlabsinc.com"
)


def is_glaze_slug(slug: str) -> bool:
    return bool(_GLAZE_SLUG_RE.match(slug.strip("/").lower()))


class AmacoAdapter(SourceAdapter):
    manufacturer = ManufacturerKey.AMACO
    politeness = Politeness(crawl_delay_s=10.0, user_agent=USER_AGENT)
    # robots.txt lists AI agents (ClaudeBot, GPTBot, anthropic-ai, ...) with a
    # Crawl-delay of 10 and *no* Disallow: /. Product pages are permitted; the delay
    # is honoured by the Fetcher, and a full glaze pass therefore takes ~50 minutes.

    coat_order = (CoatLevel.LIGHT, CoatLevel.SLIGHTLY_LIGHT, CoatLevel.SLIGHTLY_HEAVY)
    """AMACO's composites read thin-to-thick left to right, three tiles per image —
    the splitter refuses anything that is not exactly three, so HEAVY never appears."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def discover(self, since: datetime | None = None) -> AsyncIterator[ProductRef]:
        """Walk the BigCommerce XML sitemap, yielding glaze products only.

        AMACO's sitemap emits ``<loc>`` and nothing else — **no ``lastmod``** — so
        ``since`` cannot prune the work list here and is honoured only if a future
        source supplies the field. Change detection therefore happens one level down,
        in the Fetcher: a conditional GET carrying the ETag we stored last time turns
        an unchanged product into a 304 with no body, no parse, and no new snapshot
        row. The 10s crawl-delay still makes a full sweep ~50 minutes either way, which
        is acceptable for a weekly schedule but is why nothing here runs on demand.
        """
        client = self._client or httpx.AsyncClient(
            headers={"User-Agent": self.politeness.user_agent}, timeout=45.0
        )
        page = 1
        while True:
            response = await client.get(SITEMAP_URL.format(page=page))
            if response.status_code == 404:
                return
            response.raise_for_status()
            refs = list(parse_sitemap(response.text))
            if not refs:
                return
            for ref in refs:
                if not is_glaze_slug(urlsplit(str(ref.url)).path):
                    continue
                if since and ref.lastmod and ref.lastmod <= since:
                    continue
                yield ref
            page += 1

    def parse(self, snap: RawSnapshot) -> ParsedProduct:
        return parse_product(snap)

    def interpret_image(self, img: ParsedImage, ctx: ParsedProduct) -> ImageFacts:
        return interpret_filename(img.raw_filename, ctx.code, ctx.name)

    def product_ref(self, slug: str) -> ProductRef:
        clean = slug.strip("/")
        return ProductRef(url=PRODUCT_URL.format(slug=clean), external_id=clean)

    def external_id_for(self, url: str) -> str:
        return _external_id(url)

    def cone_range_for_category(self, category: str) -> tuple[str, str] | None:
        return CATEGORY_CONE_RANGE.get(category)


def parse_sitemap(xml: str) -> list[ProductRef]:
    """Read <url><loc>/<lastmod> pairs. Tolerant of the namespace prefix varying."""
    tree = HTMLParser(xml)
    refs: list[ProductRef] = []
    for node in tree.css("url"):
        loc = node.css_first("loc")
        if loc is None or not (url := loc.text().strip()):
            continue
        lastmod_node = node.css_first("lastmod")
        lastmod: datetime | None = None
        if lastmod_node and (raw := lastmod_node.text().strip()):
            try:
                lastmod = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                lastmod = None
        refs.append(ProductRef(url=url, external_id=_external_id(url), lastmod=lastmod))
    return refs

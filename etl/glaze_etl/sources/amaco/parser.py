"""Turns a stored AMACO product page into facts. Pure — no network, clock, or database.

AMACO runs BigCommerce Stencil, which gives us two reliable footholds:

* a JSON-LD ``Product`` block with name, description, brand and offers, and a
  ``BreadcrumbList`` that places the product in its glaze line;
* a ``[data-image-gallery]`` container holding only the product's *own* photographs.

That container matters more than it looks. The page also renders related-product
carousels and kiln-parts recommendations, so scraping every ``<img>`` pulls in slab
rollers and kiln elements. Scoping to the gallery removes that entire class of error.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlsplit

from selectolax.parser import HTMLParser

from glaze_etl.core.models import (
    GlazeBadges,
    ManufacturerKey,
    Opacity,
    ParsedImage,
    ParsedProduct,
    RawSnapshot,
)
from glaze_etl.sources.amaco.filename_grammar import normalize_code
from glaze_etl.sources.amaco.vocabulary import (
    BADGE_ICONS,
    GLAZE_LINE_CODES,
    GLAZE_LINE_NAMES,
    PROP65_ICON_PREFIX,
    PROP65_ICON_SUFFIX,
)

_LINE_ALT = "|".join(c.lower() for c in GLAZE_LINE_CODES)
_NAME_CODE_RE = re.compile(rf"^\s*({_LINE_ALT})[-_ ]?(\d{{1,3}})\b", re.IGNORECASE)
_CACHE_BUSTER_RE = re.compile(r"__\d+\.\d+(?=\.[a-z]+$)")
# Badges are PNGs. AMACO also misfiles the occasional product photograph under
# /image-manager/ as a .jpg (`lug-53-applicationtiles.jpg`,
# `v-309deepyellow-conevariationchartnew.jpg`), and those are pictures of glaze, not
# property claims — treating them as unknown badges would bury the real ones.
_ICON_RE = re.compile(r"/image-manager/([^/?\"']+\.png)", re.IGNORECASE)

GALLERY_SELECTOR = "[data-image-gallery] a[data-fancybox='image-gallery']"


def _json_ld_blocks(tree: HTMLParser) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(node.text())
        except (json.JSONDecodeError, ValueError):
            continue  # A malformed block is not a reason to lose the whole page.
        out.extend(d for d in (data if isinstance(data, list) else [data]) if isinstance(d, dict))
    return out


def _basename(url: str) -> str:
    return urlsplit(url).path.rsplit("/", 1)[-1]


def strip_cache_buster(filename: str) -> str:
    """``PC-20_..._Chip-hires__54961.1659532780.jpg`` -> ``PC-20_..._Chip-hires.jpg``.

    BigCommerce appends an upload id and timestamp. Removing them makes the filename
    stable across re-uploads, which keeps grammar output comparable over time.
    """
    return _CACHE_BUSTER_RE.sub("", filename)


def extract_badges(tree: HTMLParser) -> GlazeBadges:
    """Read the property icons AMACO renders instead of a spec table.

    Unrecognised icons are collected rather than ignored: a new AMACO badge should
    show up in the review queue, not silently cost us a filterable property.
    """
    fields: dict[str, Any] = {}
    unknown: list[str] = []
    seen: set[str] = set()

    for match in _ICON_RE.finditer(tree.html or ""):
        icon = match.group(1)
        if icon in seen:
            continue
        seen.add(icon)

        lowered = icon.lower()
        if lowered.startswith(PROP65_ICON_PREFIX) or lowered.endswith(PROP65_ICON_SUFFIX):
            fields["prop65"] = True
            continue
        mapping = BADGE_ICONS.get(icon)
        if mapping is None:
            unknown.append(icon)
            continue
        field, value = mapping
        fields[field] = Opacity(value) if field == "opacity" and isinstance(value, str) else value

    return GlazeBadges(**fields, unknown_icons=tuple(sorted(unknown)))


def parse_product(snap: RawSnapshot) -> ParsedProduct:
    tree = HTMLParser(snap.body)
    blocks = _json_ld_blocks(tree)

    product = next((b for b in blocks if b.get("@type") == "Product"), {})
    name = str(product.get("name") or "").strip()
    if not name:
        title = tree.css_first("title")
        name = (title.text() if title else "").split("|")[0].strip()

    # Breadcrumbs place the product in its line: Home > Glazes > High Fire > (PC) ...
    crumbs: tuple[str, ...] = ()
    for block in blocks:
        if block.get("@type") == "BreadcrumbList":
            items = block.get("itemListElement") or []
            crumbs = tuple(
                str((i.get("item") or {}).get("name", "")).strip()
                for i in items
                if isinstance(i, dict)
            )

    # Breadcrumb shape: Home > Glazes & Underglazes > <cone bracket> > <line> > product
    cone_category = crumbs[2] if len(crumbs) > 3 else None

    code_match = _NAME_CODE_RE.match(name)
    line_code = code_match.group(1).upper() if code_match else None
    code = normalize_code(code_match.group(1), code_match.group(2)) if code_match else name

    offers = product.get("offers") or {}
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    prices = [
        float(v)
        for key in ("lowPrice", "highPrice", "price")
        if (v := offers.get(key)) not in (None, "")
    ]

    images: list[ParsedImage] = []
    for anchor in tree.css(GALLERY_SELECTOR):
        href = anchor.attributes.get("href")
        if not href:
            continue
        inner = anchor.css_first("img")
        images.append(
            ParsedImage(
                source_url=href,
                raw_filename=strip_cache_buster(_basename(href)),
                alt=(inner.attributes.get("alt") if inner else None) or None,
                title=anchor.attributes.get("title") or None,
            )
        )

    return ParsedProduct(
        manufacturer=ManufacturerKey.AMACO,
        external_id=urlsplit(str(snap.url)).path.strip("/"),
        product_url=str(snap.url),
        code=code,
        name=name,
        line_code=line_code,
        line_name=GLAZE_LINE_NAMES.get(line_code) if line_code else None,
        cone_category=cone_category,
        breadcrumb=crumbs,
        description=(str(product["description"]).strip() if product.get("description") else None),
        price_min=min(prices) if prices else None,
        price_max=max(prices) if prices else None,
        availability=(
            str(offers.get("availability", "")).rsplit("/", 1)[-1] or None if offers else None
        ),
        images=tuple(images),
        badges=extract_badges(tree),
    )

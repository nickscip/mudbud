"""Turns a stored Mayco Store API response into facts. Pure — no network, clock, database.

Mayco runs WooCommerce and exposes its **Store API** at `/wp-json/wc/store/v1/products`
with no authentication. That is the source of truth here rather than the product page,
which is worth justifying because the Epic F reconnaissance concluded the opposite:

* the page carries no ``"@type":"Product"`` JSON-LD, only ``WebPage`` and
  ``BreadcrumbList``, so DOM scraping was the only option it found;
* the API carries `sku`, which the page's title and slug do not reliably. `EZ112`'s slug
  is literally ``lilac`` — no code in it at all — and the slug's separator disagrees with
  the SKU's for 89 products. Any slug-derived code would be wrong for those;
* the API carries the `categories` array, and the category tree is the only honest glaze
  filter Mayco offers (`color/fired/*` versus `tools/*`, `forms/*`, `non-fired/*`);
* it is a versioned contract, so it does not move when the theme does.

A snapshot body is therefore JSON: the response to ``?slug=<slug>``, which is a list
holding one product.
"""

from __future__ import annotations

import html
import json
import re
from typing import Any
from urllib.parse import urlsplit

from selectolax.parser import HTMLParser

from glaze_etl.core.models import (
    GlazeBadges,
    ManufacturerKey,
    ParsedImage,
    ParsedProduct,
    RawSnapshot,
)
from glaze_etl.sources.mayco.filename_grammar import normalize_sku
from glaze_etl.sources.mayco.urls import external_id as external_id_for_slug
from glaze_etl.sources.mayco.vocabulary import (
    BADGE_VALUES,
    CONE_UNSTATED,
    IGNORED_ATTRIBUTES,
    LINE_IGNORED_CATEGORIES,
    RECOGNIZED_NO_BADGE,
)

_FIRED_CHILD_RE = re.compile(r"/product-category/color/fired/([^/]+)/")
_PLACEHOLDER_RE = re.compile(r"image-coming-soon", re.IGNORECASE)
_IMG_SRC_RE = re.compile(r"""src\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


def clean_text(value: str) -> str:
    """Decode entities, drop markup, normalise whitespace.

    The Store API returns `short_description` and `description` as rendered HTML —
    ``<p><strong>Cone 6:</strong> …</p>`` — and the trademark glyphs in line names arrive
    escaped (``Stroke &amp; Coat®``). Both need undoing exactly once, and non-breaking
    spaces become ordinary ones because they are a CMS artefact that breaks wrapping on a
    phone.
    """
    text = HTMLParser(value).text(separator=" ") if "<" in value else value
    return re.sub(r"\s+", " ", html.unescape(text).replace("\xa0", " ")).strip()


def _attr_key(name: str) -> str:
    """Attribute names, comparable. Mayco spells one both "Country Of Origin" and
    "Country of Origin", so case and punctuation cannot be load-bearing."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _value_token(value: str) -> str:
    """Reduce an attribute value to the token the vocabulary is keyed on.

    Mayco states the same fact as an icon URL, as prose, and once as a raw ``<img>`` tag.
    All three collapse here: the icon's basename and the slugified prose are the same
    string, which is why one vocabulary entry covers "Dinnerware Safe with Clear Glaze"
    and ``dinnerware-safe-with-clear-glaze.png``.
    """
    text = value.strip()
    if match := _IMG_SRC_RE.search(text):
        text = match.group(1)
    if "//" in text or text.lower().endswith((".png", ".jpg", ".gif", ".svg")):
        text = urlsplit(text).path.rsplit("/", 1)[-1]
        text = re.sub(r"\.[a-z]{3,4}$", "", text, flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "-", html.unescape(text).lower()).strip("-")


def extract_badges(attributes: list[dict[str, Any]]) -> GlazeBadges:
    """Map the attribute table onto badge fields.

    Unrecognised attribute *names* land in `unknown_icons` so a new Mayco property reaches
    the review queue rather than costing us a filter silently. Recognised names whose value
    we cannot map are reported the same way, keyed by name so the pair is identifiable.
    """
    fields: dict[str, Any] = {}
    unknown: list[str] = []

    for attribute in attributes:
        key = _attr_key(str(attribute.get("name") or ""))
        if not key or key in IGNORED_ATTRIBUTES:
            continue
        terms = [str(t.get("name") or "") for t in (attribute.get("terms") or [])]
        if not terms:
            unknown.append(key)
            continue
        for term in terms:
            token = _value_token(term)
            if (key, token) in RECOGNIZED_NO_BADGE:
                continue
            mapping = BADGE_VALUES.get((key, token))
            if mapping is None:
                unknown.append(f"{key}={token}" if token else key)
                continue
            field, value = mapping
            # A negative is never overwritten by a positive. FN-219 carries the ACMI AP
            # *and* CL seals at once, which is contradictory source data; when a source
            # contradicts itself about a safety property, the cautionary reading is the
            # one to keep.
            if fields.get(field) is False:
                continue
            fields[field] = value

    return GlazeBadges(**fields, unknown_icons=tuple(sorted(set(unknown))))


def _line(categories: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The category that is a direct child of `color/fired/`, which is the glaze line.

    Read off the `link` path rather than the flat slug list, because the array mixes depths:
    Bead and Melt Gloop are children of Ritual Glazes, and both should resolve to the
    Ritual Glazes line rather than becoming lines of nine products each.

    Deliberately not derived from the code prefix, which does not work: `SG` spans Designer
    Liner, Snow Gems and Cobblestone, and `SW` spans seven different lines.
    """
    for category in categories:
        slug = str(category.get("slug") or "")
        if slug in LINE_IGNORED_CATEGORIES:
            continue
        match = _FIRED_CHILD_RE.search(str(category.get("link") or ""))
        if match and match.group(1) == slug:
            return category
    return None


def _price(prices: dict[str, Any]) -> tuple[float | None, float | None]:
    """Woo prices are integers in the currency's minor unit.

    ``{"price": "695", "currency_minor_unit": 2}`` is $6.95. Dividing is not optional —
    reading it as dollars is a 100x error on every glaze in the catalog.

    ``price_range`` is present for the 398 products sold in several jar sizes and carries
    the real spread; the flat `price` is the cheapest of them. A zero becomes ``None``
    rather than 0.0: 15 products are unpriced, and "From $0.00" is a wrong answer where
    "no price" is the true one.
    """
    unit = 10 ** int(prices.get("currency_minor_unit") or 0)

    def amount(raw: object) -> float | None:
        if raw in (None, ""):
            return None
        try:
            value = int(str(raw))
        except ValueError:
            return None
        return value / unit if value else None

    if isinstance(span := prices.get("price_range"), dict):
        low, high = amount(span.get("min_amount")), amount(span.get("max_amount"))
        if low is not None or high is not None:
            return low, high
    flat = amount(prices.get("price"))
    return flat, flat


def _images(entries: list[dict[str, Any]]) -> tuple[ParsedImage, ...]:
    """Every gallery image, at full size.

    `src` is the original upload; `thumbnail` and the `srcset` entries are WordPress's
    generated crops of the same picture. Taking `src` avoids uploading a 300x300 thumbnail
    and colour-naming that instead of the photograph.
    """
    images: list[ParsedImage] = []
    for entry in entries:
        source = str(entry.get("src") or "")
        if not source or _PLACEHOLDER_RE.search(source):
            # `image-coming-soon.jpg` is Mayco's placeholder for an unphotographed
            # product. It is a picture of nothing and would colour-name as grey.
            continue
        images.append(
            ParsedImage(
                source_url=source,
                raw_filename=urlsplit(source).path.rsplit("/", 1)[-1],
                alt=str(entry.get("alt") or "").strip() or None,
                title=str(entry.get("name") or "").strip() or None,
            )
        )
    return tuple(images)


def parse_product(snap: RawSnapshot) -> ParsedProduct:
    payload = json.loads(snap.body)
    entries = payload if isinstance(payload, list) else [payload]
    if not entries or not isinstance(entries[0], dict):
        raise ValueError(f"no product in the Store API response for {snap.url}")
    product: dict[str, Any] = entries[0]

    sku = str(product.get("sku") or "").strip()
    name = clean_text(str(product.get("name") or ""))
    if not sku:
        # The code is the identity half of (manufacturer, code). Every one of the 651
        # fired products has a SKU, so an absent one means the response is not what we
        # think it is — louder is better than inventing a code from the slug.
        raise ValueError(f"Store API product {name or snap.url!r} carries no sku")

    line = _line(list(product.get("categories") or []))
    line_code = str(line["slug"]) if line else None
    cone_category = line_code if line_code and line_code not in CONE_UNSTATED else None

    description = clean_text(str(product.get("short_description") or "")) or clean_text(
        str(product.get("description") or "")
    )
    price_min, price_max = _price(dict(product.get("prices") or {}))

    return ParsedProduct(
        manufacturer=ManufacturerKey.MAYCO,
        # The post slug, taken from the permalink rather than from the API URL the snapshot
        # was fetched from: the external id identifies the product, and the API endpoint is
        # only how we happened to read it. Must agree with the adapter's `external_id_for`,
        # which is the one place that shape is decided.
        external_id=external_id_for_slug(str(product.get("permalink") or snap.url)),
        # Likewise the human page, because this is what the app links out to and credits.
        product_url=str(product.get("permalink") or snap.url),
        code=normalize_sku(sku),
        name=name or normalize_sku(sku),
        line_code=line_code,
        line_name=clean_text(str(line["name"])) if line else None,
        cone_category=cone_category,
        breadcrumb=tuple(
            clean_text(str(c.get("name") or "")) for c in (product.get("categories") or [])
        ),
        description=description or None,
        price_min=price_min,
        price_max=price_max,
        # Spelled like AMACO's schema.org tail so the column means one thing across sources.
        availability="InStock" if product.get("is_in_stock") else "OutOfStock",
        images=_images(list(product.get("images") or [])),
        badges=extract_badges(list(product.get("attributes") or [])),
    )

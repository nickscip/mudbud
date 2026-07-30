"""Mayco's URL shapes, in one place.

A leaf module rather than functions on the adapter, because both the adapter and the parser
need them and the adapter already imports the parser — so putting them on the adapter would
either invert that dependency or, worse, invite a second copy in the parser. A second copy is
exactly the F4 bug: two implementations of "what is this product's id" disagreed about whether
the answer was a whole URL path or its last segment, identical for AMACO and wrong for Mayco.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

SITE = "https://www.maycocolors.com"
PRODUCTS_API = f"{SITE}/wp-json/wc/store/v1/products"
PRODUCT_API_URL = f"{PRODUCTS_API}?slug={{slug}}"
"""What the Fetcher stores. The product *page* carries no `Product` JSON-LD, so the Store API
response is the snapshot body; `?slug=` returns a one-element list."""

PERMALINK = f"{SITE}/product/{{slug}}/"
"""The human page — what `product_url` holds, and what attribution links out to."""


def slug_from(url: str) -> str:
    """Recover the post slug from either shape of Mayco product URL, or from a bare slug.

    Accepts all three because all three occur: `discover` reads permalinks out of the sitemap,
    the Fetcher stores API URLs, and someone types a bare slug at the CLI.
    """
    parts = urlsplit(url)
    if slugs := parse_qs(parts.query).get("slug"):
        return slugs[0].strip("/")
    return parts.path.strip("/").removeprefix("product/").strip("/")


def external_id(slug: str) -> str:
    """The product's stable per-source key: its post slug, bare.

    Bare rather than the `product/…` path, for two reasons. It preserves the invariant AMACO
    already has — the external id is exactly what `product_ref` accepts — where a prefixed id
    would only round-trip because `slug_from` strips the prefix again. And
    `Loader.upsert_glaze` binds this value to `glazes.slug`, a column whose name promises a
    slug; `product/s-2709-cappuccino-mint` is not one.
    """
    return slug_from(slug)

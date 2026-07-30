from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from glaze_etl.core.models import RawSnapshot
from glaze_etl.sources import adapter_for

FIXTURES_ROOT = Path(__file__).parent / "fixtures"

SNAPSHOT_SUFFIXES = (".html", ".json")
"""What a stored product body can be. A snapshot is whatever the source serves at its
product URL, and that is not always markup: AMACO stores BigCommerce HTML, Mayco stores
a WooCommerce Store API response. Keeping the extension honest means a fixture reads as
what it is instead of as HTML that happens to contain JSON."""


def fixture_dir(source: str = "amaco") -> Path:
    """One directory per source — `fixtures/<key>/` — mirroring the adapter registry."""
    return FIXTURES_ROOT / source


def fixture_path(name: str, source: str = "amaco") -> Path:
    """Resolve a fixture stem to the one checked-in file, whatever its extension.

    Raises rather than returning a missing path, and raises again if two extensions
    exist for the same stem — a duplicate would make which body a test reads depend on
    suffix ordering.
    """
    found = [p for s in SNAPSHOT_SUFFIXES if (p := fixture_dir(source) / f"{name}{s}").exists()]
    if not found:
        tried = ", ".join(f"{name}{s}" for s in SNAPSHOT_SUFFIXES)
        raise FileNotFoundError(f"no fixture for {name!r} in {source}: tried {tried}")
    if len(found) > 1:
        raise AssertionError(f"ambiguous fixture {name!r} in {source}: {[p.name for p in found]}")
    return found[0]


def snapshot_for(slug: str, source: str = "amaco") -> RawSnapshot:
    """Build a RawSnapshot from a checked-in product body, exactly as the Fetcher would.

    The URL comes from the adapter's `product_ref`, not a template here, so every
    parser run also exercises the slug-to-URL seam the targeted CLI commands rely on.
    """
    body = fixture_path(f"product-{slug}", source).read_text()
    return RawSnapshot(
        url=str(adapter_for(source).product_ref(slug).url),
        fetched_at=datetime(2026, 7, 26, tzinfo=UTC),
        http_status=200,
        body=body,
        content_hash=hashlib.sha256(body.encode()).hexdigest(),
    )


def raw_snapshot(name: str, url: str, source: str) -> RawSnapshot:
    """A snapshot for a fixture that is deliberately not named `product-<slug>`.

    The source-agnostic contract test requires every `product-*` fixture to parse to a
    code, a line, an image and a price. Cases that exist because they *don't* — an
    unpriced product, one with no line, a non-glaze — still need parsing in their own
    per-source tests, and this is how they get a snapshot without claiming to be one.
    """
    body = fixture_path(name, source).read_text()
    return RawSnapshot(
        url=url,
        fetched_at=datetime(2026, 7, 26, tzinfo=UTC),
        http_status=200,
        body=body,
        content_hash=hashlib.sha256(body.encode()).hexdigest(),
    )


def all_product_slugs(source: str = "amaco") -> list[str]:
    return sorted(
        p.name[len("product-") : -len(p.suffix)]
        for s in SNAPSHOT_SUFFIXES
        for p in fixture_dir(source).glob(f"product-*{s}")
    )

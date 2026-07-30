from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from glaze_etl.core.models import RawSnapshot
from glaze_etl.sources import adapter_for

FIXTURES_ROOT = Path(__file__).parent / "fixtures"


def fixture_dir(source: str = "amaco") -> Path:
    """One directory per source — `fixtures/<key>/` — mirroring the adapter registry."""
    return FIXTURES_ROOT / source


def snapshot_for(slug: str, source: str = "amaco") -> RawSnapshot:
    """Build a RawSnapshot from a checked-in page, exactly as the Fetcher would.

    The URL comes from the adapter's `product_ref`, not a template here, so every
    parser run also exercises the slug-to-URL seam the targeted CLI commands rely on.
    """
    body = (fixture_dir(source) / f"product-{slug}.html").read_text()
    return RawSnapshot(
        url=str(adapter_for(source).product_ref(slug).url),
        fetched_at=datetime(2026, 7, 26, tzinfo=UTC),
        http_status=200,
        body=body,
        content_hash=hashlib.sha256(body.encode()).hexdigest(),
    )


def all_product_slugs(source: str = "amaco") -> list[str]:
    return sorted(
        p.name[len("product-") : -len(".html")]
        for p in fixture_dir(source).glob("product-*.html")
    )

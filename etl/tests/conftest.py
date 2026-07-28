from __future__ import annotations

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from glaze_etl.core.models import RawSnapshot

FIXTURES = Path(__file__).parent / "fixtures" / "amaco"


def snapshot_for(slug: str) -> RawSnapshot:
    """Build a RawSnapshot from a checked-in page, exactly as the Fetcher would."""
    body = (FIXTURES / f"product-{slug}.html").read_text()
    return RawSnapshot(
        url=f"https://shop.amaco.com/{slug}/",
        fetched_at=datetime(2026, 7, 26, tzinfo=UTC),
        http_status=200,
        body=body,
        content_hash=hashlib.sha256(body.encode()).hexdigest(),
    )


def all_product_slugs() -> list[str]:
    return sorted(p.name[len("product-") : -len(".html")] for p in FIXTURES.glob("product-*.html"))


@pytest.fixture
def product_slugs() -> Iterator[list[str]]:
    yield all_product_slugs()

"""`ingest_product`'s one decision of its own: turning region ordinals into coat levels.

Everything else in the pipeline delegates — the adapter parses and classifies, the loader
writes, the media processor measures. The exception is the coat axis: the splitter hands
back regions numbered left to right, and the pipeline maps those onto coat levels through
the adapter's `coat_order`. That translation, and its guard, are the subject here.

Loader and MediaProcessor are stubbed, since both exist to hold I/O handles and neither is
what is under test. The adapter is a real `AmacoAdapter`, so the image is classified
`COATS_COMPOSITE` by the shipped filename grammar rather than by a mock asserting itself.
"""

from __future__ import annotations

from typing import cast

import pytest

from glaze_etl.core.color import ColorReading, Lab
from glaze_etl.core.composite_splitter import BBox
from glaze_etl.core.loader import Loader
from glaze_etl.core.media import MediaProcessor, RegionReading, StoredImage
from glaze_etl.core.models import ParsedProduct
from glaze_etl.core.payloads import ImagePayload
from glaze_etl.core.pipeline import ingest_product
from glaze_etl.sources.amaco.adapter import AmacoAdapter
from tests.conftest import snapshot_for

COMPOSITE_SLUG = "pc-20-blue-rutile"
"""Its gallery holds an application-tiles composite, so the real filename grammar
classifies one image `COATS_COMPOSITE` and the split path is genuinely reached."""


def _reading(hex_code: str) -> ColorReading:
    return ColorReading(
        dominant=Lab(50.0, 0.0, 0.0),
        secondary=None,
        dominant_hex=hex_code,
        secondary_hex=None,
        pixels_sampled=100,
    )


def _regions(count: int) -> tuple[RegionReading, ...]:
    return tuple(
        RegionReading(
            bbox=BBox(left=ordinal * 10, top=0, right=ordinal * 10 + 10, bottom=10),
            color=_reading(f"#00000{ordinal}"),
            ordinal=ordinal,
        )
        for ordinal in range(count)
    )


class StubLoader:
    """Records what the pipeline asked to write, and nothing else."""

    def __init__(self) -> None:
        self.payloads: list[ImagePayload] = []
        self.issues: list[tuple[str, str]] = []

    def upsert_line(
        self, product: ParsedProduct, *, cone_range: tuple[str, str] | None
    ) -> int | None:
        return 1

    def upsert_glaze(self, product: ParsedProduct, line_id: int | None) -> int:
        return 2

    def known_sha256(self, source_url: str) -> str | None:
        return None

    def record_issue(
        self, manufacturer: str, kind: str, subject: str, detail: dict[str, object]
    ) -> None:
        self.issues.append((kind, subject))

    def upsert_image(self, glaze_id: int, payload: ImagePayload) -> int:
        self.payloads.append(payload)
        return len(self.payloads)

    def replace_appearances(
        self, glaze_id: int, image_id: int, payload: ImagePayload, *, manufacturer: str
    ) -> int:
        return len(payload.regions) or 1


class StubMedia:
    """Returns regions only when the pipeline asked for a split, which is the causal
    chain the guard depends on: adapter classifies a composite, so the splitter runs, so
    ordinals arrive needing a coat level."""

    def __init__(self, region_count: int) -> None:
        self._region_count = region_count

    async def process(
        self,
        source_url: str,
        *,
        split_composite: bool = False,
        known_sha256: str | None = None,
    ) -> StoredImage:
        return StoredImage(
            sha256="deadbeef",
            width=100,
            height=100,
            storage_key="l/de/deadbeef.jpg",
            color=_reading("#123456"),
            regions=_regions(self._region_count) if split_composite else (),
        )


async def _ingest(adapter: AmacoAdapter, region_count: int = 3) -> StubLoader:
    loader = StubLoader()
    await ingest_product(
        snapshot_for(COMPOSITE_SLUG),
        adapter,
        cast(Loader, loader),
        cast(MediaProcessor, StubMedia(region_count)),
        None,
    )
    return loader


class NoCoatOrderAdapter(AmacoAdapter):
    """A source that classifies composites but never said what their tiles mean — the
    half-built state a new adapter passes through."""

    coat_order = ()


class TestCoatOrder:
    async def test_regions_map_onto_the_adapters_coat_order(self) -> None:
        """Ordinal 0 is the thinnest coat because `coat_order` says so, not because the
        pipeline knows anything about how AMACO photographs tiles."""
        loader = await _ingest(AmacoAdapter())

        composites = [p for p in loader.payloads if p.regions]
        assert composites, f"no image in {COMPOSITE_SLUG} reached the split path"
        for payload in composites:
            assert [r.coat_level for r in payload.regions] == list(AmacoAdapter.coat_order)

    async def test_a_composite_without_any_coat_order_fails_loudly(self) -> None:
        """The `IndexError` this guard replaces would have named neither the source nor
        the missing attribute, and would have arrived mid-write."""
        with pytest.raises(ValueError, match="coat_order"):
            await _ingest(NoCoatOrderAdapter())

    async def test_a_coat_order_shorter_than_the_regions_fails_too(self) -> None:
        """Not just the empty case: a source that grows a fourth tile without extending
        `coat_order` is the same bug arriving later."""
        with pytest.raises(ValueError, match="coat_order"):
            await _ingest(AmacoAdapter(), region_count=len(AmacoAdapter.coat_order) + 1)

"""The seam between the generic pipeline and any one manufacturer's website.

Everything manufacturer-specific lives behind this interface. Adding a second source
means one new subclass plus its grammar module — no stage, workflow, or table changes.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from datetime import datetime

from glaze_etl.core.models import (
    ImageFacts,
    ManufacturerKey,
    ParsedImage,
    ParsedProduct,
    Politeness,
    ProductRef,
    RawSnapshot,
)


class SourceAdapter(ABC):
    manufacturer: ManufacturerKey
    politeness: Politeness

    @abstractmethod
    def discover(self, since: datetime | None = None) -> AsyncIterator[ProductRef]:
        """Enumerate the source's glaze products.

        ``since`` filters on the source's own last-modified signal so routine syncs
        fetch only what changed. Implementations should yield lazily — the caller
        paces itself against ``politeness.crawl_delay_s``.
        """

    @abstractmethod
    def parse(self, snap: RawSnapshot) -> ParsedProduct:
        """Turn stored HTML into facts. Pure: no network, no clock, no database.

        Purity is what lets ReparseWorkflow replay the entire corpus in seconds.
        """

    @abstractmethod
    def interpret_image(self, img: ParsedImage, ctx: ParsedProduct) -> ImageFacts:
        """Read whatever the source encodes about an image — usually in its filename.

        Must not guess. An unresolved token lowers confidence and is reported; it never
        becomes a fact.
        """

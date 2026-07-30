"""Runs one product through every stage.

Sequencing this in one place keeps the CLI and the Temporal activities from drifting
apart — both call `ingest_product`, and the workflow adds retries and scheduling around
it rather than reimplementing the order of operations.
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog

from glaze_etl.core.color_namer import ColorNamer
from glaze_etl.core.loader import Loader
from glaze_etl.core.media import MediaProcessor
from glaze_etl.core.models import CoatLevel, ImageRole, ParsedProduct, RawSnapshot
from glaze_etl.core.payloads import ImagePayload, RegionPayload
from glaze_etl.core.source_adapter import SourceAdapter

log = structlog.get_logger(__name__)

_COAT_ORDER: tuple[CoatLevel, ...] = (
    CoatLevel.LIGHT,
    CoatLevel.SLIGHTLY_LIGHT,
    CoatLevel.SLIGHTLY_HEAVY,
)
"""AMACO's composites read thin-to-thick left to right, and the splitter returns boxes in
that order. Mapping lives here rather than in the splitter so the assumption is visible at
the point where it becomes data."""


@dataclass
class IngestResult:
    code: str
    images: int
    appearances: int
    color_terms: list[str]


async def ingest_product(
    snapshot: RawSnapshot,
    adapter: SourceAdapter,
    loader: Loader,
    media: MediaProcessor | None,
    namer: ColorNamer | None,
) -> IngestResult:
    """Parse, interpret, measure, and load one product.

    ``media`` and ``namer`` are optional so the pipeline can run without touching image
    bandwidth — useful when iterating on the grammar, where the HTML is all that matters.
    """
    product = adapter.parse(snapshot)
    cone_range = (
        adapter.cone_range_for_category(product.cone_category)
        if product.cone_category
        else None
    )
    line_id = loader.upsert_line(product, cone_range)
    glaze_id = loader.upsert_glaze(product, line_id)

    _report_unknown_badges(loader, product)

    appearances = 0
    color_terms: list[str] = []

    for image in product.images:
        facts = adapter.interpret_image(image, product)
        payload = ImagePayload(
            facts=facts,
            source_url=str(image.source_url),
            raw_filename=image.raw_filename,
        )

        if media is not None:
            try:
                stored = await media.process(
                    str(image.source_url),
                    split_composite=facts.role is ImageRole.COATS_COMPOSITE,
                    # Lets MediaProcessor serve from the local cache instead of asking the
                    # manufacturer's CDN for bytes we already hold.
                    known_sha256=loader.known_sha256(str(image.source_url)),
                )
            except (ValueError, OSError) as exc:
                loader.record_issue(
                    product.manufacturer.value,
                    "image_unreadable",
                    image.raw_filename,
                    {"error": str(exc), "url": str(image.source_url)},
                )
            else:
                if stored.split_refusal:
                    # The thickness axis is the point of a composite, so a refusal is worth
                    # reviewing rather than silently absorbing.
                    loader.record_issue(
                        product.manufacturer.value,
                        "composite_unsplit",
                        image.raw_filename,
                        {"reason": stored.split_refusal},
                    )
                payload = ImagePayload(
                    facts=facts,
                    source_url=str(image.source_url),
                    raw_filename=image.raw_filename,
                    regions=tuple(
                        RegionPayload(
                            coat_level=_COAT_ORDER[region.ordinal],
                            crop_bbox=region.bbox.as_dict(),
                            hex_dominant=region.color.dominant_hex,
                            hex_secondary=region.color.secondary_hex,
                            lab=region.color.dominant.as_tuple(),
                            lab_secondary=(
                                region.color.secondary.as_tuple()
                                if region.color.secondary
                                else None
                            ),
                        )
                        for region in stored.regions
                    ),
                    storage_path=stored.storage_key,
                    sha256=stored.sha256,
                    width=stored.width,
                    height=stored.height,
                    hex_dominant=stored.color.dominant_hex,
                    hex_secondary=stored.color.secondary_hex,
                    lab=stored.color.dominant.as_tuple(),
                    lab_secondary=(
                        stored.color.secondary.as_tuple() if stored.color.secondary else None
                    ),
                )
                # A line chart is mostly white paper, so its measured colour describes
                # the page rather than any glaze. Never let it name a colour.
                if namer is not None and facts.role is not ImageRole.LINE_CHART:
                    color_terms += namer.terms_for(
                        stored.color.dominant, stored.color.secondary
                    )

        image_id = loader.upsert_image(glaze_id, payload)
        appearances += loader.replace_appearances(glaze_id, image_id, payload)

    if color_terms:
        loader.refresh_color_terms(glaze_id, color_terms)

    log.info(
        "ingest.done",
        code=product.code,
        images=len(product.images),
        appearances=appearances,
        terms=sorted(set(color_terms)),
    )
    return IngestResult(product.code, len(product.images), appearances, sorted(set(color_terms)))


def _report_unknown_badges(loader: Loader, product: ParsedProduct) -> None:
    """An unrecognised icon costs a filterable property, so it must surface.

    Note the deliberate asymmetry with the fixture suite: `test_no_unrecognised_badge_icons`
    *fails* on an unknown icon, because 14 checked-in pages are a tripwire we want tripped.
    Here, in the live crawl, the product still loads and the icon becomes a review item.
    """
    for icon in product.badges.unknown_icons:
        loader.record_issue(
            product.manufacturer.value, "unknown_badge_icon", product.code, {"icon": icon}
        )

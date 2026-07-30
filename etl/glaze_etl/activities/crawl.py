"""Temporal activities. Every side effect the pipeline has lives behind one of these.

Workflows must be deterministic and replayable, so HTTP, image decoding and SQL are all
confined here. The activities are thin: they open a connection, call the same core class
the CLI calls, and return a serialisable result. Keeping the logic in `core` is what makes
the CLI and the worker impossible to drift apart.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

import httpx
import psycopg
from temporalio import activity

from glaze_etl.core.blob_store import BlobStore, LocalBlobStore, SupabaseBlobStore
from glaze_etl.core.color import Lab
from glaze_etl.core.color_namer import ColorNamer, ColorTerm
from glaze_etl.core.config import Settings
from glaze_etl.core.db import connect as db_connect
from glaze_etl.core.fetcher import Fetcher, FetchOutcome
from glaze_etl.core.loader import Loader
from glaze_etl.core.media import MediaProcessor
from glaze_etl.core.models import ProductRef
from glaze_etl.core.normalizer import Normalizer, load_vocabularies
from glaze_etl.core.pipeline import ingest_product
from glaze_etl.core.store import PostgresSnapshotStore
from glaze_etl.sources import adapter_for


@dataclass
class DiscoverInput:
    manufacturer: str
    limit: int = 0


@dataclass
class FetchInput:
    manufacturer: str
    url: str


@dataclass
class FetchOutput:
    url: str
    outcome: str
    stored: bool


@dataclass
class IngestInput:
    manufacturer: str
    url: str
    with_images: bool = True


@dataclass
class IngestOutput:
    code: str
    images: int
    appearances: int


@activity.defn
async def discover_products(payload: DiscoverInput) -> list[str]:
    """Return the glaze product URLs worth fetching.

    Cheap — one sitemap request. Kept as its own activity so the workflow's work list is
    durable: a worker restart mid-crawl resumes from the same list rather than re-deriving
    a possibly different one.
    """
    adapter = adapter_for(payload.manufacturer)
    urls: list[str] = []
    async for ref in adapter.discover():
        urls.append(str(ref.url))
        if payload.limit and len(urls) >= payload.limit:
            break
    activity.logger.info("discovered %d glaze products", len(urls))
    return urls


@activity.defn
async def fetch_product(payload: FetchInput) -> FetchOutput:
    """Fetch one page. The crawl delay is enforced by the workflow, not here.

    Spacing requests is a property of the whole crawl, and an activity cannot see its
    siblings. Doing it in the workflow also means the wait is durable — it survives a
    worker restart instead of turning into a burst.
    """
    settings = Settings()
    adapter = adapter_for(payload.manufacturer)
    # The external id is derived here rather than carried in the payload: slug-from-URL
    # is source knowledge, and a workflow computing it its own way once disagreed with
    # the adapter about whether the id is the whole path or its last segment.
    ref = ProductRef(url=payload.url, external_id=adapter.external_id_for(payload.url))

    with db_connect(settings.database_url, autocommit=True) as conn:
        store = PostgresSnapshotStore(conn)
        async with httpx.AsyncClient(
            timeout=settings.request_timeout_s, follow_redirects=True
        ) as client:
            fetcher = Fetcher(
                client,
                store,
                adapter.manufacturer,
                adapter.politeness,
                volatile_patterns=adapter.volatile_patterns,
                retention=settings.snapshot_retention,
                max_attempts=settings.max_attempts,
            )
            result = await fetcher.fetch(ref)

    return FetchOutput(
        url=result.url,
        outcome=result.outcome.value,
        stored=result.outcome is FetchOutcome.STORED,
    )


@activity.defn
async def ingest_snapshot(payload: IngestInput) -> IngestOutput:
    """Parse, measure and load the newest stored snapshot for one URL.

    Reads from `raw_snapshots` rather than taking the body as an argument: a page is
    ~75KB, and pushing that through Temporal's payload layer on every retry would be
    wasteful when the durable copy is already in Postgres.
    """
    settings = Settings()
    adapter = adapter_for(payload.manufacturer)

    with db_connect(settings.database_url) as conn:
        snapshot = PostgresSnapshotStore(conn).newest(payload.url, adapter.manufacturer)
        if snapshot is None:
            raise ValueError(
                f"no snapshot stored for {payload.url} under {adapter.manufacturer.value}"
            )

        loader = Loader(conn, Normalizer(load_vocabularies(conn)))
        namer = _color_namer(conn)

        async with httpx.AsyncClient(
            timeout=settings.request_timeout_s,
            headers={"User-Agent": adapter.politeness.user_agent},
        ) as client:
            media = (
                MediaProcessor(
                    client,
                    _blob_store(settings, payload.manufacturer),
                    byte_cache=settings.blob_dir,
                )
                if payload.with_images
                else None
            )
            result = await ingest_product(snapshot, adapter, loader, media, namer)
        conn.commit()

    return IngestOutput(result.code, result.images, result.appearances)


@activity.defn
async def finalise(manufacturer: str) -> dict[str, int]:
    """Cross-product passes that can only run once every glaze exists.

    Layering links a glaze to the base it sits over, and the base may be crawled after
    the image that references it. Cone inheritance needs the line rows populated.
    """
    settings = Settings()
    with db_connect(settings.database_url) as conn:
        loader = Loader(conn, Normalizer(load_vocabularies(conn)))
        cones = loader.inherit_line_cones()
        links = loader.link_layering()
        conn.commit()
    activity.logger.info("finalise: %d cone ranges inherited, %d layering links", cones, links)
    return {"cone_inherited": cones, "layer_links": links}


def _blob_store(settings: Settings, manufacturer: str) -> BlobStore:
    """Same rule as the CLI: hosted private bucket when configured, local cache otherwise.

    One bucket per manufacturer, derived — `mudbud_amaco`.
    """
    if settings.supabase_url and settings.secret_key:
        return SupabaseBlobStore(
            settings.supabase_url, settings.secret_key, settings.bucket_for(manufacturer)
        )
    return LocalBlobStore(settings.blob_dir)


def _color_namer(conn: psycopg.Connection[tuple[object, ...]]) -> ColorNamer:
    rows = conn.execute(
        "select term, lab_l, lab_a, lab_b, max_delta_e, is_potter_term, family from color_terms"
    ).fetchall()
    vocabulary: list[ColorTerm] = []
    for term, lightness, green_red, blue_yellow, radius, potter, family in rows:
        vocabulary.append(
            ColorTerm(
                str(term),
                Lab(_f(lightness), _f(green_red), _f(blue_yellow)),
                _f(radius),
                bool(potter),
                str(family) if family else None,
            )
        )
    return ColorNamer(vocabulary)


def _f(value: object) -> float:
    assert isinstance(value, int | float)
    return float(value)


ALL_ACTIVITIES: Sequence[Callable[..., Any]] = [
    discover_products,
    fetch_product,
    ingest_snapshot,
    finalise,
]

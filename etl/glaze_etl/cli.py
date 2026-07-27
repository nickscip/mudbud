"""Command line entry point.

Steps 1-6 of the build deliberately run here rather than under Temporal: a pipeline that
is still wrong is far easier to debug as a synchronous script than as a workflow. The
Temporal activities added later call the same core classes, so nothing is rewritten.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated

import httpx
import psycopg
import structlog
import typer

from glaze_etl.core.color import Lab
from glaze_etl.core.color_namer import ColorNamer, ColorTerm
from glaze_etl.core.config import Settings
from glaze_etl.core.db import connect as db_connect
from glaze_etl.core.db import stored_object_keys
from glaze_etl.core.fetcher import Fetcher, FetchOutcome
from glaze_etl.core.loader import Loader
from glaze_etl.core.media import BlobStore, LocalBlobStore, MediaProcessor, SupabaseBlobStore
from glaze_etl.core.models import ManufacturerKey, ProductRef, RawSnapshot
from glaze_etl.core.normalizer import Normalizer, load_vocabularies
from glaze_etl.core.pipeline import ingest_product
from glaze_etl.core.store import (
    InMemorySnapshotStore,
    PostgresSnapshotStore,
    SnapshotStore,
)
from glaze_etl.sources.amaco.adapter import AmacoAdapter

app = typer.Typer(add_completion=False, help="Glaze catalog ETL.")

structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="%H:%M:%S"),
        structlog.dev.ConsoleRenderer(),
    ]
)
log = structlog.get_logger("glaze_etl")


@app.command()
def discover(
    limit: Annotated[int, typer.Option(help="Stop after this many refs.")] = 20,
) -> None:
    """List the glaze products the sitemap exposes. Costs one request, no page fetches."""

    async def run() -> None:
        adapter = AmacoAdapter()
        shown = 0
        async for ref in adapter.discover():
            typer.echo(ref.external_id)
            shown += 1
            if shown >= limit:
                break
        typer.echo(f"\n{shown} glaze products (limit {limit})")

    asyncio.run(run())


@app.command()
def crawl(
    slug: Annotated[list[str] | None, typer.Argument(help="Specific slugs, or all.")] = None,
    limit: Annotated[int, typer.Option(help="Cap products when crawling everything.")] = 5,
    dry_run: Annotated[bool, typer.Option(help="Skip the database entirely.")] = False,
) -> None:
    """Fetch, parse and interpret. Honours the 10s crawl-delay, so budget ~10s per product."""
    settings = Settings()
    adapter = AmacoAdapter()

    async def run() -> None:
        refs: list[ProductRef]
        if slug:
            refs = [
                ProductRef(url=f"https://shop.amaco.com/{s.strip('/')}/", external_id=s.strip("/"))
                for s in slug
            ]
        else:
            refs = []
            async for ref in adapter.discover():
                refs.append(ref)
                if len(refs) >= limit:
                    break

        log.info("crawl.start", products=len(refs), delay_s=adapter.politeness.crawl_delay_s)

        conn = None if dry_run else db_connect(settings.database_url, autocommit=True)
        try:
            store = _store_for(conn)
            async with httpx.AsyncClient(
                timeout=settings.request_timeout_s, follow_redirects=True
            ) as client:
                fetcher = Fetcher(
                    client,
                    store,
                    ManufacturerKey.AMACO,
                    adapter.politeness,
                    retention=settings.snapshot_retention,
                    max_attempts=settings.max_attempts,
                )
                for ref in refs:
                    result = await fetcher.fetch(ref)
                    if result.outcome is not FetchOutcome.STORED or result.snapshot is None:
                        log.info("crawl.skip", slug=ref.external_id, outcome=result.outcome.value)
                        continue
                    _report(adapter, result.snapshot)
        finally:
            if conn is not None:
                conn.close()

    asyncio.run(run())


def _store_for(conn: psycopg.Connection[tuple[object, ...]] | None) -> SnapshotStore:
    """A dry run still exercises the dedupe and retention logic, just in memory."""
    return InMemorySnapshotStore() if conn is None else PostgresSnapshotStore(conn)


def _report(adapter: AmacoAdapter, snapshot: RawSnapshot) -> None:
    """Print what the pure stages made of one page, so a bad parse is obvious by eye."""
    product = adapter.parse(snapshot)
    badges = product.badges
    typer.secho(f"\n{product.code}  {product.name}", bold=True)
    typer.echo(f"  line     {product.line_code} ({product.line_name})")
    typer.echo(f"  price    {product.price_min}-{product.price_max}  {product.availability}")
    typer.echo(
        "  badges   "
        + " ".join(
            f"{k}={v}"
            for k, v in (
                ("opacity", badges.opacity.value if badges.opacity else None),
                ("ap", badges.ap_seal),
                ("food", badges.food_safe),
                ("spray", badges.spray_safe),
            )
            if v is not None
        )
    )
    if badges.unknown_icons:
        typer.secho(f"  UNKNOWN ICONS {badges.unknown_icons}", fg=typer.colors.YELLOW)

    for image in product.images:
        facts = adapter.interpret_image(image, product)
        bits = [facts.role.value]
        if facts.subject_code:
            bits.append(f"subject={facts.subject_code}")
        if facts.layered_over_code:
            bits.append(f"over={facts.layered_over_code}")
        if facts.combination_codes:
            bits.append("combo=" + "+".join(facts.combination_codes))
        if facts.cone:
            bits.append(f"cone={facts.cone}")
        if facts.clay_body_number:
            bits.append(f"clay={facts.clay_body_number}")
        if facts.form:
            bits.append(f"form={facts.form.value}")
        colour = {
            "high": typer.colors.GREEN,
            "medium": typer.colors.WHITE,
            "low": typer.colors.YELLOW,
        }[facts.confidence.value]
        typer.secho(f"  [{facts.confidence.value:6}] {' '.join(bits)}", fg=colour)
        if facts.unmatched_tokens:
            typer.echo(f"           unresolved: {list(facts.unmatched_tokens)}")


@app.command()
def reparse(
    dry_run: Annotated[bool, typer.Option(help="Report only; write nothing.")] = True,
) -> None:
    """Replay stored snapshots through the current grammar. No network.

    This is why raw_snapshots exists: iterating on the filename rules costs seconds
    here, against ~50 minutes for a re-crawl at AMACO's mandated delay.
    """
    settings = Settings()
    adapter = AmacoAdapter()
    counts = {"high": 0, "medium": 0, "low": 0}
    products = 0

    with db_connect(settings.database_url) as conn:
        # Newest snapshot per URL only; older ones are history, not current truth.
        rows = conn.execute(
            """
            select distinct on (url) url, fetched_at, http_status, etag, content_hash, body
            from raw_snapshots
            order by url, fetched_at desc
            """
        ).fetchall()

    for url, fetched_at, status, etag, digest, body in rows:
        snapshot = RawSnapshot(
            url=url,
            fetched_at=fetched_at,
            http_status=status,
            etag=etag,
            content_hash=digest,
            body=body,
        )
        product = adapter.parse(snapshot)
        products += 1
        for image in product.images:
            counts[adapter.interpret_image(image, product).confidence.value] += 1

    typer.echo(f"reparsed {products} products, {sum(counts.values())} images")
    typer.echo(f"  high {counts['high']}  medium {counts['medium']}  low {counts['low']}")
    if dry_run:
        typer.echo("dry run: nothing written")


def _blob_store(
    settings: Settings,
    blob_dir: str,
    manufacturer: str,
    known_keys: set[str] | None = None,
) -> BlobStore:
    """Prefer the hosted private bucket when configured, else the local cache.

    Chosen by whether credentials exist rather than by a flag, so the same command works in
    development and against a real project without anyone remembering to pass anything.

    The bucket is per manufacturer — `mudbud_amaco` — so a second source cannot write its
    images into the first one's bucket.
    """
    if settings.supabase_url and settings.secret_key:
        bucket = settings.bucket_for(manufacturer)
        log.info("blobs.supabase", bucket=bucket)
        return SupabaseBlobStore(
            settings.supabase_url, settings.secret_key, bucket, known_keys=known_keys
        )
    log.info("blobs.local", path=blob_dir)
    return LocalBlobStore(Path(blob_dir))


def _color_namer(conn: psycopg.Connection[tuple[object, ...]]) -> ColorNamer:
    rows = conn.execute(
        "select term, lab_l, lab_a, lab_b, max_delta_e, is_potter_term, family from color_terms"
    ).fetchall()
    vocabulary: list[ColorTerm] = []
    for term, lightness, green_red, blue_yellow, radius, potter, family in rows:
        centroid = Lab(_f(lightness), _f(green_red), _f(blue_yellow))
        vocabulary.append(
            ColorTerm(
                str(term), centroid, _f(radius), bool(potter),
                str(family) if family else None,
            )
        )
    return ColorNamer(vocabulary)


def _f(value: object) -> float:
    """psycopg hands back `object` for numeric columns; narrow it once, here."""
    assert isinstance(value, int | float)
    return float(value)


@app.command()
def load(
    slug: Annotated[list[str] | None, typer.Argument(help="Specific slugs, or all stored.")] = None,
    images: Annotated[bool, typer.Option(help="Download and measure images.")] = True,
    blob_dir: Annotated[str, typer.Option(help="Where cached images go.")] = "./.blobs",
) -> None:
    """Load stored snapshots into the catalog. No crawling — run `crawl` first.

    Splitting load from crawl is what makes the grammar cheap to iterate on: re-loading
    the whole corpus costs seconds, against ~50 minutes to re-crawl it.
    """
    settings = Settings()
    adapter = AmacoAdapter()

    async def run() -> None:
        with db_connect(settings.database_url) as conn:
            normalizer = Normalizer(load_vocabularies(conn))
            loader = Loader(conn, normalizer)
            namer = _color_namer(conn)

            query = """
                select distinct on (url) url, fetched_at, http_status, etag, content_hash, body
                from raw_snapshots
                {where}
                order by url, fetched_at desc
            """
            if slug:
                patterns = [f"https://shop.amaco.com/{s.strip('/')}/" for s in slug]
                rows = conn.execute(
                    query.format(where="where url = any(%s)"), (patterns,)
                ).fetchall()
            else:
                rows = conn.execute(query.format(where="")).fetchall()

            log.info("load.start", snapshots=len(rows), images=images)

            async with httpx.AsyncClient(
                timeout=settings.request_timeout_s,
                headers={"User-Agent": adapter.politeness.user_agent},
            ) as client:
                already = stored_object_keys(conn, settings.bucket_for(adapter.manufacturer.value))
                if already:
                    log.info("blobs.known", objects=len(already))
                blobs = _blob_store(settings, blob_dir, adapter.manufacturer.value, already)
                # The local directory doubles as a byte cache even when blobs go to
                # Supabase, so switching backends does not re-download the corpus.
                media = (
                    MediaProcessor(client, blobs, byte_cache=Path(blob_dir))
                    if images
                    else None
                )
                for url, fetched_at, status, etag, digest, body in rows:
                    snapshot = RawSnapshot(
                        url=url,
                        fetched_at=fetched_at,
                        http_status=status,
                        etag=etag,
                        content_hash=digest,
                        body=body,
                    )
                    await ingest_product(snapshot, adapter, loader, media, namer)

            inherited = loader.inherit_line_cones()
            linked = loader.link_layering()
            conn.commit()

        stats = loader.stats
        typer.secho(
            f"\nglazes {stats.glazes}  images {stats.images}  appearances {stats.appearances}"
            f"  layering links {linked}  cone-inherited {inherited}  issues {stats.issues}",
            bold=True,
        )

    asyncio.run(run())


if __name__ == "__main__":
    app()

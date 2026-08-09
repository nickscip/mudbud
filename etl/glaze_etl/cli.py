"""Command line entry point, and the only way the pipeline runs.

Every command is a synchronous script over the same `core/` classes: a pipeline that is
still wrong is far easier to debug this way than through an orchestrator, and the
scheduled path is this same `sync` command invoked by `.github/workflows/sync-catalog.yml`
rather than a second implementation that can drift.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

import httpx
import psycopg
import structlog
import typer

from glaze_etl.core.blob_gc import (
    database_matches_storage_project,
    exceeds_safety_threshold,
    plan_blob_sweep,
    recheck_orphans,
    reference_set_looks_wrong,
)
from glaze_etl.core.blob_store import blob_store_for
from glaze_etl.core.color_namer import load_color_namer
from glaze_etl.core.config import Settings
from glaze_etl.core.db import connect as db_connect
from glaze_etl.core.db import referenced_shas, stored_object_ages, stored_object_keys
from glaze_etl.core.fetcher import Fetcher, FetchOutcome
from glaze_etl.core.loader import Loader
from glaze_etl.core.media import MediaProcessor
from glaze_etl.core.models import ProductRef, RawSnapshot
from glaze_etl.core.pipeline import ingest_product, normalizer_for
from glaze_etl.core.source_adapter import SourceAdapter
from glaze_etl.core.store import (
    InMemorySnapshotStore,
    PostgresSnapshotStore,
    SnapshotStore,
)
from glaze_etl.sources import adapter_for

app = typer.Typer(add_completion=False, help="Glaze catalog ETL.")

structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="%H:%M:%S"),
        structlog.dev.ConsoleRenderer(),
    ]
)
log = structlog.get_logger("glaze_etl")

ManufacturerOption = Annotated[str, typer.Option(help="Source key, e.g. amaco.")]


@app.command()
def discover(
    limit: Annotated[int, typer.Option(help="Stop after this many refs.")] = 20,
    manufacturer: ManufacturerOption = "amaco",
) -> None:
    """List the glaze products the sitemap exposes. Costs one request, no page fetches."""

    async def run() -> None:
        adapter = adapter_for(manufacturer)
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
    manufacturer: ManufacturerOption = "amaco",
) -> None:
    """Fetch, parse and interpret. Honours the 10s crawl-delay, so budget ~10s per product."""
    settings = Settings()
    adapter = adapter_for(manufacturer)

    async def run() -> None:
        refs: list[ProductRef]
        if slug:
            refs = [adapter.product_ref(s) for s in slug]
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
                    adapter.manufacturer,
                    adapter.politeness,
                    volatile_patterns=adapter.volatile_patterns,
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


def _report(adapter: SourceAdapter, snapshot: RawSnapshot) -> None:
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
    manufacturer: ManufacturerOption = "amaco",
) -> None:
    """Replay stored snapshots through the current grammar. No network.

    This is why raw_snapshots exists: iterating on the filename rules costs seconds
    here, against ~50 minutes for a re-crawl at AMACO's mandated delay.
    """
    settings = Settings()
    adapter = adapter_for(manufacturer)
    counts = {"high": 0, "medium": 0, "low": 0}
    products = 0

    with db_connect(settings.database_url) as conn:
        snapshots = PostgresSnapshotStore(conn).newest_per_url(adapter.manufacturer)

    for snapshot in snapshots:
        product = adapter.parse(snapshot)
        products += 1
        for image in product.images:
            counts[adapter.interpret_image(image, product).confidence.value] += 1

    typer.echo(f"reparsed {products} products, {sum(counts.values())} images")
    typer.echo(f"  high {counts['high']}  medium {counts['medium']}  low {counts['low']}")
    if dry_run:
        typer.echo("dry run: nothing written")


@app.command()
def load(
    slug: Annotated[list[str] | None, typer.Argument(help="Specific slugs, or all stored.")] = None,
    images: Annotated[bool, typer.Option(help="Download and measure images.")] = True,
    blob_dir: Annotated[str, typer.Option(help="Where cached images go.")] = "./.blobs",
    manufacturer: ManufacturerOption = "amaco",
) -> None:
    """Load stored snapshots into the catalog. No crawling — run `crawl` first.

    Splitting load from crawl is what makes the grammar cheap to iterate on: re-loading
    the whole corpus costs seconds, against ~50 minutes to re-crawl it.
    """
    settings = Settings()
    adapter = adapter_for(manufacturer)

    async def run() -> None:
        with db_connect(settings.database_url) as conn:
            normalizer = normalizer_for(conn, adapter)
            loader = Loader(conn, normalizer)
            namer = load_color_namer(conn)

            # Must byte-match what the Fetcher stored, so build URLs via the adapter.
            urls = [str(adapter.product_ref(s).url) for s in slug] if slug else None
            snapshots = PostgresSnapshotStore(conn).newest_per_url(adapter.manufacturer, urls)

            log.info("load.start", snapshots=len(snapshots), images=images)

            async with httpx.AsyncClient(
                timeout=settings.request_timeout_s,
                headers={"User-Agent": adapter.politeness.user_agent},
            ) as client:
                already = stored_object_keys(conn, settings.bucket_for(adapter.manufacturer.value))
                if already:
                    log.info("blobs.known", objects=len(already))
                blobs = blob_store_for(
                    settings,
                    adapter.manufacturer.value,
                    blob_dir=Path(blob_dir),
                    known_keys=already,
                )
                # The local directory doubles as a byte cache even when blobs go to
                # Supabase, so switching backends does not re-download the corpus.
                media = (
                    MediaProcessor(client, blobs, byte_cache=Path(blob_dir))
                    if images
                    else None
                )
                for snapshot in snapshots:
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


@app.command()
def sync(
    slug: Annotated[
        list[str] | None, typer.Argument(help="Specific slugs, or omit for the catalog.")
    ] = None,
    limit: Annotated[int, typer.Option(help="Cap products. 0 = the whole catalog.")] = 0,
    images: Annotated[bool, typer.Option(help="Download and measure images.")] = True,
    blob_dir: Annotated[str, typer.Option(help="Local image cache.")] = "./.blobs",
    manufacturer: ManufacturerOption = "amaco",
) -> None:
    """Crawl and ingest in one pass, touching only what changed. The command a cron runs.

    `crawl` then `load` also works, but `load` reprocesses all 352 products every time — fine
    by hand, wasteful on a schedule. Here a product is parsed only if its fetch actually stored
    a new snapshot, so a steady-state week does ~350 conditional GETs and almost no work.

    This is what `.github/workflows/sync-catalog.yml` invokes weekly, so the scheduled path
    and the manual one cannot drift apart — there is only one of them.
    """
    settings = Settings()
    adapter = adapter_for(manufacturer)

    async def run() -> None:
        refs: list[ProductRef] = []
        if slug:
            # Targeted re-sync, e.g. after fixing the grammar for one product.
            refs = [adapter.product_ref(s) for s in slug]
        else:
            async for ref in adapter.discover():
                refs.append(ref)
                if limit and len(refs) >= limit:
                    break

        log.info("sync.start", products=len(refs), delay_s=adapter.politeness.crawl_delay_s)
        stored = unchanged = ingested = 0
        failed: list[str] = []

        with db_connect(settings.database_url) as conn:
            loader = Loader(conn, normalizer_for(conn, adapter))
            namer = load_color_namer(conn)
            already = stored_object_keys(conn, settings.bucket_for(adapter.manufacturer.value))
            blobs = blob_store_for(
                settings,
                adapter.manufacturer.value,
                blob_dir=Path(blob_dir),
                known_keys=already,
            )

            async with httpx.AsyncClient(
                timeout=settings.request_timeout_s,
                follow_redirects=True,
                headers={"User-Agent": adapter.politeness.user_agent},
            ) as client:
                media = (
                    MediaProcessor(client, blobs, byte_cache=Path(blob_dir)) if images else None
                )
                fetcher = Fetcher(
                    client,
                    PostgresSnapshotStore(conn),
                    adapter.manufacturer,
                    adapter.politeness,
                    volatile_patterns=adapter.volatile_patterns,
                    retention=settings.snapshot_retention,
                    max_attempts=settings.max_attempts,
                )

                for ref in refs:
                    result = await fetcher.fetch(ref)
                    if result.outcome is not FetchOutcome.STORED or result.snapshot is None:
                        unchanged += 1
                        continue
                    stored += 1
                    try:
                        await ingest_product(result.snapshot, adapter, loader, media, namer)
                        ingested += 1
                    # The snapshot is committed either way, so reparse can retry this later.
                    except Exception as exc:
                        log.warning("sync.ingest_failed", slug=ref.external_id, error=str(exc))
                        failed.append(ref.external_id)
                    conn.commit()

            cones = loader.inherit_line_cones()
            links = loader.link_layering()
            conn.commit()

        typer.secho(
            f"\nchanged {stored}  unchanged {unchanged}  ingested {ingested}  "
            f"cone-inherited {cones}  layering {links}  failed {len(failed)}",
            bold=True,
        )
        if failed:
            typer.secho("  failed: " + ", ".join(failed[:10]), fg=typer.colors.YELLOW)

    asyncio.run(run())


@app.command()
def gc(
    manufacturer: ManufacturerOption = "amaco",
    prune: Annotated[
        bool, typer.Option(help="Delete orphaned objects instead of only reporting.")
    ] = False,
    force: Annotated[
        bool, typer.Option(help="Override the high-orphan-fraction refusal.")
    ] = False,
    min_age_minutes: Annotated[
        int,
        typer.Option(
            help="Only delete objects at least this old, to outrun the upload-then-commit gap."
        ),
    ] = 60,
) -> None:
    """Report — and, with `--prune`, delete — bucket objects no `glaze_images` row cites.

    Report-only by default, so a bare `glaze-etl gc` is always safe to run. Deletion is
    irreversible, so this refuses outright (no override) when the database and Storage
    endpoint do not identify the same Supabase project or when the computed reference set
    is empty against a non-empty bucket. It also refuses unless `--force` when the orphan
    fraction looks implausibly high.
    """
    settings = Settings()
    bucket = settings.bucket_for(manufacturer)
    conn = db_connect(settings.database_url, autocommit=True)
    try:
        info = conn.info
        typer.echo(f"database {info.host}/{info.dbname}  bucket {bucket}")

        referenced = referenced_shas(conn, manufacturer)
        ages = stored_object_ages(conn, bucket)

        if prune and not database_matches_storage_project(
            info.host,
            info.user,
            settings.supabase_url,
        ):
            typer.secho(
                "refusing: the database connection and SUPABASE_URL do not identify "
                "the same Supabase project; gc will not delete across an unknown or "
                "mismatched project boundary",
                fg=typer.colors.RED,
            )
            raise typer.Exit(code=1)

        if reference_set_looks_wrong(len(referenced), len(ages)):
            typer.secho(
                "refusing: 0 referenced shas against a non-empty bucket — check "
                "SUPABASE_DB_URL and the bucket pairing before running gc",
                fg=typer.colors.RED,
            )
            raise typer.Exit(code=1)

        sweep = plan_blob_sweep(
            referenced,
            ages,
            now=datetime.now(UTC),
            min_age=timedelta(minutes=min_age_minutes),
        )
        typer.echo(
            f"referenced shas {sweep.referenced_sha_count}  "
            f"bucket objects {sweep.bucket_key_count}  "
            f"orphaned shas {len(sweep.orphaned_shas)}  "
            f"orphaned objects {len(sweep.orphaned_keys)}  "
            f"held back as too recent {len(sweep.recent_shas)}"
        )
        if sweep.unexpected_keys:
            typer.secho(
                f"warning: {len(sweep.unexpected_keys)} bucket object(s) did not parse as "
                "a managed key and were left untouched",
                fg=typer.colors.YELLOW,
            )

        if not sweep.orphaned_keys or not prune:
            typer.echo("dry run: pass --prune to delete")
            return

        if (
            exceeds_safety_threshold(len(sweep.orphaned_keys), sweep.bucket_key_count)
            and not force
        ):
            typer.secho(
                "refusing: orphan fraction exceeds the safety threshold — pass --force "
                "to override",
                fg=typer.colors.RED,
            )
            raise typer.Exit(code=1)

        # Recomputed immediately before deleting, so nothing referenced since the report
        # above was printed gets swept — the age gate bounds upload-to-commit, not how
        # long a human sits on this report before choosing --prune.
        newly_referenced = referenced_shas(conn, manufacturer)
        to_delete = recheck_orphans(sweep.orphaned_keys, newly_referenced)

        blobs = blob_store_for(settings, manufacturer)
        blobs.remove(sorted(to_delete))
        typer.secho(f"deleted {len(to_delete)} object(s)", bold=True)
    finally:
        conn.close()


@app.command()
def report() -> None:
    """Print catalog state as markdown. Used for the CI job summary."""
    settings = Settings()
    with db_connect(settings.database_url) as conn:
        rows = conn.execute(
            """
            select
              (select count(*) from glazes),
              (select count(*) from appearances),
              (select count(*) from appearances where coat_level_id is not null),
              (select count(*) from appearances where clay_body_id is not null),
              (select count(*) from appearances where layered_over_glaze_id is not null),
              (select count(*) from glazes where cone_from_id is null),
              (select count(*) from parse_issues where resolved_at is null)
            """
        ).fetchone()
        assert rows is not None
        issues = conn.execute(
            "select kind, count(*) from parse_issues where resolved_at is null group by kind"
        ).fetchall()

    glazes, appearances, coats, clays, layered, no_cone, open_issues = rows
    typer.echo("## Catalog\n")
    typer.echo("| | |\n|---|---|")
    for label, value in [
        ("Glazes", glazes),
        ("Appearances", appearances),
        ("With coat thickness", coats),
        ("With a clay body", clays),
        ("Layering combinations", layered),
        ("Missing a cone range", no_cone),
        ("Open review items", open_issues),
    ]:
        typer.echo(f"| {label} | {value} |")
    if issues:
        typer.echo("\n### Review queue\n")
        for kind, count in issues:
            typer.echo(f"- `{kind}` x {count}")


if __name__ == "__main__":
    app()

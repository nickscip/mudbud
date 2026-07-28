"""Workflows. Deterministic orchestration only — every side effect is an activity.

The scheduling problem here is unusual in that the bottleneck is politeness, not
throughput: AMACO's robots.txt mandates a 10-second crawl delay, so a full 352-glaze pass
takes about an hour no matter how many workers exist. That shapes the design:

* fetches are strictly sequential, spaced by `workflow.sleep`, which is durable — a
  worker restart resumes the wait instead of turning it into a burst;
* image work and loading are *not* spaced, because they hit our own database and our own
  cache, so they run as soon as their page is in hand;
* the whole thing is one workflow rather than a fan-out, because fanning out would
  violate the delay the site asked for.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from glaze_etl.activities.crawl import (
        DiscoverInput,
        FetchInput,
        IngestInput,
        discover_products,
        fetch_product,
        finalise,
        ingest_snapshot,
    )

CRAWL_DELAY = timedelta(seconds=10)

# A withdrawn product or an unparseable page is a fact about the catalog, not a transient
# fault, so those raise application errors that Temporal will not retry.
FETCH_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    backoff_coefficient=2.0,
    maximum_attempts=4,
    non_retryable_error_types=["ValueError"],
)


@dataclass
class SyncInput:
    manufacturer: str = "amaco"
    limit: int = 0
    """0 crawls everything the sitemap offers."""
    with_images: bool = True


@dataclass
class SyncOutput:
    discovered: int = 0
    fetched: int = 0
    unchanged: int = 0
    ingested: int = 0
    failed: list[str] = field(default_factory=list)
    cone_inherited: int = 0
    layer_links: int = 0


@workflow.defn
class SyncManufacturerWorkflow:
    """The weekly crawl. One run covers a manufacturer's whole glaze catalog."""

    @workflow.run
    async def run(self, payload: SyncInput) -> SyncOutput:
        result = SyncOutput()

        urls = await workflow.execute_activity(
            discover_products,
            DiscoverInput(payload.manufacturer, payload.limit),
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=FETCH_RETRY,
        )
        result.discovered = len(urls)

        for index, url in enumerate(urls):
            if index > 0:
                # Durable, and deliberately before the fetch rather than after, so a
                # retry cannot collapse the gap between two requests.
                await workflow.sleep(CRAWL_DELAY)

            external_id = url.rstrip("/").rsplit("/", 1)[-1]
            try:
                fetched = await workflow.execute_activity(
                    fetch_product,
                    FetchInput(payload.manufacturer, url, external_id),
                    start_to_close_timeout=timedelta(minutes=3),
                    retry_policy=FETCH_RETRY,
                )
            # One bad product must not end an hour-long crawl.
            except Exception:
                result.failed.append(url)
                continue

            if not fetched.stored:
                result.unchanged += 1
                continue
            result.fetched += 1

            try:
                await workflow.execute_activity(
                    ingest_snapshot,
                    IngestInput(payload.manufacturer, url, payload.with_images),
                    start_to_close_timeout=timedelta(minutes=10),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                result.ingested += 1
            # The snapshot is already stored, so reparse can pick this up later.
            except Exception:
                result.failed.append(url)

        totals = await workflow.execute_activity(
            finalise,
            payload.manufacturer,
            start_to_close_timeout=timedelta(minutes=5),
        )
        result.cone_inherited = totals["cone_inherited"]
        result.layer_links = totals["layer_links"]
        return result


@dataclass
class ReparseInput:
    manufacturer: str = "amaco"
    urls: list[str] = field(default_factory=list)
    """Empty reparses every stored snapshot."""


@workflow.defn
class ReparseWorkflow:
    """Replay stored snapshots through the current grammar. No network, no crawl delay.

    This is the payoff for keeping `raw_snapshots`: a filename-grammar change can be
    validated across the whole corpus in seconds, where re-crawling would take an hour of
    someone else's bandwidth.
    """

    @workflow.run
    async def run(self, payload: ReparseInput) -> SyncOutput:
        result = SyncOutput()
        urls = payload.urls
        if not urls:
            urls = await workflow.execute_activity(
                discover_products,
                DiscoverInput(payload.manufacturer, 0),
                start_to_close_timeout=timedelta(minutes=5),
            )
        result.discovered = len(urls)

        for url in urls:
            try:
                await workflow.execute_activity(
                    ingest_snapshot,
                    # Images are already cached and content-addressed, so re-measuring
                    # them adds nothing when only the HTML grammar changed.
                    IngestInput(payload.manufacturer, url, with_images=False),
                    start_to_close_timeout=timedelta(minutes=5),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                result.ingested += 1
            # A URL with no stored snapshot yet is expected, not a failure.
            except Exception:
                result.failed.append(url)

        totals = await workflow.execute_activity(
            finalise,
            payload.manufacturer,
            start_to_close_timeout=timedelta(minutes=5),
        )
        result.cone_inherited = totals["cone_inherited"]
        result.layer_links = totals["layer_links"]
        return result


ALL_WORKFLOWS = [SyncManufacturerWorkflow, ReparseWorkflow]

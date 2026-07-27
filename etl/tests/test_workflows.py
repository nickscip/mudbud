"""Workflow tests using Temporal's time-skipping test environment.

The point of these is not to test the pipeline — the core classes have their own tests.
It is to prove the *orchestration* is sound: that no I/O leaked into a workflow body
(which would fail replay), that the mandated crawl delay is really enforced between
fetches, and that one bad product cannot end an hour-long crawl.

Time skipping means the 10-second delays cost nothing in wall clock while still being
asserted.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from glaze_etl.activities.crawl import (
    DiscoverInput,
    FetchInput,
    FetchOutput,
    IngestInput,
    IngestOutput,
)
from glaze_etl.workflows.sync import (
    ReparseInput,
    ReparseWorkflow,
    SyncInput,
    SyncManufacturerWorkflow,
)

TASK_QUEUE = "glaze-etl-test"


@dataclass
class Recorder:
    """Captures what the workflow asked for, and when."""

    fetched: list[str]
    ingested: list[str]
    fetch_times: list[float]
    finalised: int


@pytest.fixture
def recorder() -> Recorder:
    return Recorder(fetched=[], ingested=[], fetch_times=[], finalised=0)


def build_stubs(
    recorder: Recorder,
    urls: list[str],
    *,
    unchanged: set[str] | None = None,
    fetch_fails: set[str] | None = None,
    ingest_fails: set[str] | None = None,
) -> list[object]:
    """Stand-in activities. Named to match the real ones so the workflow is unmodified."""
    unchanged = unchanged or set()
    fetch_fails = fetch_fails or set()
    ingest_fails = ingest_fails or set()

    @activity.defn(name="discover_products")
    async def discover_products(payload: DiscoverInput) -> list[str]:
        return urls[: payload.limit] if payload.limit else urls

    @activity.defn(name="fetch_product")
    async def fetch_product(payload: FetchInput) -> FetchOutput:
        recorder.fetched.append(payload.url)
        recorder.fetch_times.append(activity.info().started_time.timestamp())
        if payload.url in fetch_fails:
            raise RuntimeError("simulated transport failure")
        stored = payload.url not in unchanged
        return FetchOutput(payload.url, "stored" if stored else "unchanged", stored)

    @activity.defn(name="ingest_snapshot")
    async def ingest_snapshot(payload: IngestInput) -> IngestOutput:
        if payload.url in ingest_fails:
            raise RuntimeError("simulated parse failure")
        recorder.ingested.append(payload.url)
        return IngestOutput("PC-20", 2, 2)

    @activity.defn(name="finalise")
    async def finalise(manufacturer: str) -> dict[str, int]:
        recorder.finalised += 1
        return {"cone_inherited": 3, "layer_links": 7}

    return [discover_products, fetch_product, ingest_snapshot, finalise]


async def run_sync(
    client: Client, stubs: list[object], payload: SyncInput
) -> object:
    async with Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[SyncManufacturerWorkflow, ReparseWorkflow],
        activities=stubs,  # type: ignore[arg-type]
    ):
        return await client.execute_workflow(
            SyncManufacturerWorkflow.run,
            payload,
            id=f"sync-{uuid.uuid4()}",
            task_queue=TASK_QUEUE,
        )


class TestSyncWorkflow:
    async def test_crawls_every_discovered_product(self, recorder: Recorder) -> None:
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(5)]
        async with await WorkflowEnvironment.start_time_skipping() as env:
            result = await run_sync(
                env.client, build_stubs(recorder, urls), SyncInput(limit=0)
            )

        assert result.discovered == 5  # type: ignore[attr-defined]
        assert result.fetched == 5  # type: ignore[attr-defined]
        assert result.ingested == 5  # type: ignore[attr-defined]
        assert recorder.fetched == urls

    async def test_crawl_delay_is_enforced_between_fetches(self, recorder: Recorder) -> None:
        """The site asked for 10 seconds between requests; this is where we honour it."""
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(4)]
        async with await WorkflowEnvironment.start_time_skipping() as env:
            await run_sync(env.client, build_stubs(recorder, urls), SyncInput())

        gaps = [
            later - earlier
            for earlier, later in zip(
                recorder.fetch_times, recorder.fetch_times[1:], strict=False
            )
        ]
        assert gaps, "expected more than one fetch"
        assert all(gap >= 9.5 for gap in gaps), f"crawl delay not honoured: {gaps}"

    async def test_unchanged_products_are_not_ingested(self, recorder: Recorder) -> None:
        """A 304 or an identical content hash means there is nothing new to parse."""
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(4)]
        async with await WorkflowEnvironment.start_time_skipping() as env:
            result = await run_sync(
                env.client,
                build_stubs(recorder, urls, unchanged={urls[1], urls[2]}),
                SyncInput(),
            )

        assert result.unchanged == 2  # type: ignore[attr-defined]
        assert result.ingested == 2  # type: ignore[attr-defined]
        assert urls[1] not in recorder.ingested

    async def test_a_failing_product_does_not_end_the_crawl(self, recorder: Recorder) -> None:
        """An hour of crawling must not be lost to one bad page."""
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(5)]
        async with await WorkflowEnvironment.start_time_skipping() as env:
            result = await run_sync(
                env.client,
                build_stubs(recorder, urls, fetch_fails={urls[2]}),
                SyncInput(),
            )

        assert urls[2] in result.failed  # type: ignore[attr-defined]
        assert result.ingested == 4  # type: ignore[attr-defined]
        assert urls[4] in recorder.ingested, "crawl stopped early"

    async def test_ingest_failure_is_recorded_but_tolerated(self, recorder: Recorder) -> None:
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(3)]
        async with await WorkflowEnvironment.start_time_skipping() as env:
            result = await run_sync(
                env.client,
                build_stubs(recorder, urls, ingest_fails={urls[0]}),
                SyncInput(),
            )

        assert urls[0] in result.failed  # type: ignore[attr-defined]
        assert result.fetched == 3  # type: ignore[attr-defined]

    async def test_finalise_runs_once_at_the_end(self, recorder: Recorder) -> None:
        """Layering links and cone inheritance need every glaze to exist first."""
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(3)]
        async with await WorkflowEnvironment.start_time_skipping() as env:
            result = await run_sync(env.client, build_stubs(recorder, urls), SyncInput())

        assert recorder.finalised == 1
        assert result.layer_links == 7  # type: ignore[attr-defined]

    async def test_limit_caps_the_work_list(self, recorder: Recorder) -> None:
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(10)]
        async with await WorkflowEnvironment.start_time_skipping() as env:
            result = await run_sync(env.client, build_stubs(recorder, urls), SyncInput(limit=3))

        assert result.discovered == 3  # type: ignore[attr-defined]
        assert len(recorder.fetched) == 3


class TestReparseWorkflow:
    async def test_reparse_never_fetches(self, recorder: Recorder) -> None:
        """The whole point: iterate on the grammar without touching the network."""
        urls = [f"https://shop.amaco.com/pc-{n}-x/" for n in range(4)]
        async with await WorkflowEnvironment.start_time_skipping() as env, Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[SyncManufacturerWorkflow, ReparseWorkflow],
            activities=build_stubs(recorder, urls),  # type: ignore[arg-type]
        ):
            result = await env.client.execute_workflow(
                ReparseWorkflow.run,
                ReparseInput(urls=urls),
                id=f"reparse-{uuid.uuid4()}",
                task_queue=TASK_QUEUE,
            )

        assert recorder.fetched == [], "reparse must not hit the network"
        assert result.ingested == 4  # type: ignore[attr-defined]

    async def test_reparse_skips_image_work(self, recorder: Recorder) -> None:
        """Images are content-addressed and already cached, so only the HTML matters."""
        seen: list[bool] = []

        @activity.defn(name="ingest_snapshot")
        async def ingest_snapshot(payload: IngestInput) -> IngestOutput:
            seen.append(payload.with_images)
            return IngestOutput("PC-20", 0, 0)

        stubs = build_stubs(recorder, ["https://shop.amaco.com/pc-1-x/"])
        stubs = [s for s in stubs if getattr(s, "__name__", "") != "ingest_snapshot"]
        stubs.append(ingest_snapshot)

        async with await WorkflowEnvironment.start_time_skipping() as env, Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ReparseWorkflow],
            activities=stubs,  # type: ignore[arg-type]
        ):
            await env.client.execute_workflow(
                ReparseWorkflow.run,
                ReparseInput(urls=["https://shop.amaco.com/pc-1-x/"]),
                id=f"reparse-{uuid.uuid4()}",
                task_queue=TASK_QUEUE,
            )

        assert seen == [False]

"""The Temporal worker.

Run with:
    temporal server start-dev                 # in one terminal
    uv run python -m glaze_etl.worker         # in another

Then kick off a crawl:
    temporal workflow start --type SyncManufacturerWorkflow --task-queue glaze-etl \\
        --input '{"manufacturer":"amaco","limit":0}'
"""

from __future__ import annotations

import asyncio
import concurrent.futures

import structlog
from temporalio.client import Client
from temporalio.worker import Worker

from glaze_etl.activities.crawl import ALL_ACTIVITIES
from glaze_etl.core.config import Settings
from glaze_etl.workflows.sync import ALL_WORKFLOWS

TASK_QUEUE = "glaze-etl"

log = structlog.get_logger("glaze_etl.worker")


async def main() -> None:
    settings = Settings()
    client = await Client.connect(settings.temporal_address, namespace=settings.temporal_namespace)

    # Pillow, numpy and scikit-learn all block, so activities get real threads. Without
    # this they would stall the worker's event loop and serialise every fetch behind an
    # image decode.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        worker = Worker(
            client,
            task_queue=TASK_QUEUE,
            workflows=ALL_WORKFLOWS,
            activities=ALL_ACTIVITIES,
            activity_executor=pool,
            # One fetch at a time. The 10s crawl delay is a property of the crawl as a
            # whole, so allowing concurrency here would breach it no matter what the
            # workflow does.
            max_concurrent_activities=1,
        )
        log.info(
            "worker.start",
            queue=TASK_QUEUE,
            temporal=settings.temporal_address,
            workflows=[w.__name__ for w in ALL_WORKFLOWS],
        )
        await worker.run()


if __name__ == "__main__":
    asyncio.run(main())

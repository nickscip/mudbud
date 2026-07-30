"""Polite, conditional HTTP fetching with an immutable snapshot log.

Four constraints shape this class, all measured against the live site rather than assumed:

* **AMACO's robots.txt sets `Crawl-delay: 10`** for AI agents (and no `Disallow: /`), so
  a full ~300-SKU glaze pass takes ~50 minutes no matter what. The delay is enforced
  here, in one place, rather than trusted to callers.
* **The sitemap carries no `lastmod`.** Change detection cannot come from the work list.
* **Nor can it come from HTTP validators.** BigCommerce returns no `ETag` on product
  pages and ignores `If-Modified-Since` — a repeat fetch is always a fresh 200. The
  conditional headers are still sent, because they cost nothing and a CDN change would
  start honouring them, but nothing depends on a 304 arriving.
* **So change detection rests entirely on a canonical content hash.** Every response is
  byte-unique thanks to an embedded analytics session id, so the hash has to ignore that
  noise; see `canonicalize_for_hash`. A snapshot row is written only when the canonical
  hash differs from the newest one held for that URL, and retention prunes to the N most
  recent. Without both, a weekly crawl stores ~22MB a pass of identical pages.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

import httpx
import structlog

from glaze_etl.core.models import ManufacturerKey, Politeness, ProductRef, RawSnapshot
from glaze_etl.core.store import SnapshotStore

log = structlog.get_logger(__name__)

Sleeper = Callable[[float], Awaitable[None]]
Clock = Callable[[], float]


class FetchOutcome(StrEnum):
    STORED = "stored"
    """New or changed content; a snapshot row was written."""
    UNCHANGED = "unchanged"
    """A 304, or a 200 whose bytes hashed to what we already had."""
    GONE = "gone"
    """404/410 — the product was withdrawn. Not retried."""
    FAILED = "failed"


@dataclass(frozen=True)
class FetchResult:
    url: str
    outcome: FetchOutcome
    snapshot: RawSnapshot | None = None
    status: int | None = None
    error: str | None = None

    @property
    def should_parse(self) -> bool:
        return self.outcome is FetchOutcome.STORED and self.snapshot is not None


def canonicalize_for_hash(body: str, patterns: Sequence[re.Pattern[str]] = ()) -> str:
    """Strip per-request noise so the hash tracks *content*, not bytes.

    Which byte ranges are noise is source knowledge — the adapter supplies its
    ``volatile_patterns``. Without them, change detection did not work on AMACO at all:
    BigCommerce sends no ETag and ignores If-Modified-Since, so every fetch returns a
    fresh 200, and an embedded analytics session id made every response byte-unique. A
    raw byte hash therefore reported every product as changed on every crawl, storing
    ~22MB a pass of identical pages and defeating the retention budget.

    The full body is still stored verbatim — reparse needs real HTML. Only the hash sees
    the canonical form.
    """
    for pattern in patterns:
        body = pattern.sub("", body)
    return body


def content_hash(body: str, patterns: Sequence[re.Pattern[str]] = ()) -> str:
    return hashlib.sha256(canonicalize_for_hash(body, patterns).encode("utf-8")).hexdigest()


class Fetcher:
    """Fetches product pages one at a time, no faster than the site allows."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        store: SnapshotStore,
        manufacturer: ManufacturerKey,
        politeness: Politeness,
        *,
        volatile_patterns: tuple[re.Pattern[str], ...] = (),
        retention: int = 3,
        max_attempts: int = 4,
        sleep: Sleeper | None = None,
        clock: Clock | None = None,
    ) -> None:
        self._client = client
        self._store = store
        self._manufacturer = manufacturer
        self._politeness = politeness
        # The default strips nothing on purpose: a source that forgets its patterns
        # looks byte-new every pass — loud — instead of silently reusing another
        # site's regexes.
        self._volatile_patterns = volatile_patterns
        self._retention = retention
        self._max_attempts = max_attempts
        # Injected so tests can run without wall-clock delays while still asserting
        # that the delay logic fires.
        self._sleep: Sleeper = sleep or asyncio.sleep
        self._clock: Clock = clock or time.monotonic
        self._last_request_at: float | None = None

    async def _await_turn(self) -> None:
        """Hold off until at least `crawl_delay_s` has passed since the last request."""
        if self._last_request_at is None:
            return
        elapsed = self._clock() - self._last_request_at
        remaining = self._politeness.crawl_delay_s - elapsed
        if remaining > 0:
            await self._sleep(remaining)

    async def fetch(self, ref: ProductRef) -> FetchResult:
        url = str(ref.url)
        head = self._store.head(url)
        headers = {"User-Agent": self._politeness.user_agent}
        if head and head.etag:
            headers["If-None-Match"] = head.etag
        elif head:
            # No ETag to offer, so fall back to the weaker time-based validator.
            headers["If-Modified-Since"] = head.fetched_at.strftime(
                "%a, %d %b %Y %H:%M:%S GMT"
            )

        last_error: str | None = None
        for attempt in range(1, self._max_attempts + 1):
            await self._await_turn()
            self._last_request_at = self._clock()
            try:
                response = await self._client.get(url, headers=headers)
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                log.warning("fetch.transport_error", url=url, attempt=attempt, error=last_error)
                continue

            status = response.status_code

            if status == 304:
                return FetchResult(url, FetchOutcome.UNCHANGED, status=status)

            if status in (404, 410):
                # A withdrawn product is a fact, not a failure. Retrying wastes a
                # 10-second slot per attempt for a page that will never come back.
                log.info("fetch.gone", url=url, status=status)
                return FetchResult(url, FetchOutcome.GONE, status=status)

            if 400 <= status < 500 and status != 429:
                return FetchResult(
                    url, FetchOutcome.FAILED, status=status, error=f"client error {status}"
                )

            if status >= 500 or status == 429:
                last_error = f"server error {status}"
                log.warning("fetch.retrying", url=url, status=status, attempt=attempt)
                # Back off on top of the crawl delay, which already spaces requests out.
                await self._sleep(self._politeness.crawl_delay_s * attempt)
                continue

            return self._record(ref, response)

        return FetchResult(url, FetchOutcome.FAILED, error=last_error or "exhausted attempts")

    def _record(self, ref: ProductRef, response: httpx.Response) -> FetchResult:
        url = str(ref.url)
        body = response.text
        digest = content_hash(body, self._volatile_patterns)

        previous = self._store.head(url)
        if previous is not None and previous.content_hash == digest:
            # A 200 whose bytes are identical to what we hold. Common on this site,
            # since BigCommerce does not always honour conditional requests.
            log.debug("fetch.unchanged_by_hash", url=url)
            return FetchResult(url, FetchOutcome.UNCHANGED, status=response.status_code)

        snapshot = RawSnapshot(
            url=url,
            fetched_at=datetime.now(UTC),
            http_status=response.status_code,
            body=body,
            content_hash=digest,
            etag=response.headers.get("etag"),
        )
        self._store.insert(self._manufacturer, snapshot)
        pruned = self._store.prune(url, self._retention)
        log.info("fetch.stored", url=url, bytes=len(body), pruned=pruned)
        return FetchResult(url, FetchOutcome.STORED, snapshot=snapshot, status=response.status_code)

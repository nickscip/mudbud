"""Fetcher behaviour, driven through httpx's MockTransport — no network, no real sleeps."""

from __future__ import annotations

import re

import httpx
import pytest

from glaze_etl.core.fetcher import Fetcher, FetchOutcome, content_hash
from glaze_etl.core.models import ManufacturerKey, Politeness, ProductRef
from glaze_etl.core.store import InMemorySnapshotStore
from glaze_etl.sources.amaco.adapter import VOLATILE_PATTERNS

URL = "https://shop.amaco.com/pc-20-blue-rutile/"
REF = ProductRef(url=URL, external_id="pc-20-blue-rutile")
POLITENESS = Politeness(crawl_delay_s=10.0, user_agent="mudbud-glaze-etl/0.1 (test)")


class FakeClock:
    """A clock the test advances by hand, so delay logic is asserted, not waited on."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def build(
    handler: httpx.MockTransport,
    store: InMemorySnapshotStore | None = None,
    *,
    volatile_patterns: tuple[re.Pattern[str], ...] = (),
) -> tuple[Fetcher, InMemorySnapshotStore, FakeClock]:
    store = store or InMemorySnapshotStore()
    clock = FakeClock()
    fetcher = Fetcher(
        httpx.AsyncClient(transport=handler),
        store,
        ManufacturerKey.AMACO,
        POLITENESS,
        volatile_patterns=volatile_patterns,
        retention=3,
        sleep=clock.sleep,
        clock=clock,
    )
    return fetcher, store, clock


def responder(*responses: httpx.Response) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    queue = list(responses)

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return queue.pop(0) if queue else responses[-1]

    return httpx.MockTransport(handle), seen


class TestSnapshotWriting:
    async def test_first_fetch_stores(self) -> None:
        transport, _ = responder(httpx.Response(200, text="<html>one</html>"))
        fetcher, store, _ = build(transport)

        result = await fetcher.fetch(REF)

        assert result.outcome is FetchOutcome.STORED
        assert result.should_parse
        assert len(store.rows) == 1

    async def test_identical_bytes_write_nothing(self) -> None:
        """BigCommerce does not always honour conditional requests, so a 200 with
        unchanged bytes is common. Hashing catches it before it costs a row."""
        body = "<html>same</html>"
        transport, _ = responder(httpx.Response(200, text=body), httpx.Response(200, text=body))
        fetcher, store, _ = build(transport)

        await fetcher.fetch(REF)
        second = await fetcher.fetch(REF)

        assert second.outcome is FetchOutcome.UNCHANGED
        assert not second.should_parse
        assert len(store.rows) == 1

    async def test_changed_bytes_write_a_new_row(self) -> None:
        transport, _ = responder(
            httpx.Response(200, text="<html>v1</html>"),
            httpx.Response(200, text="<html>v2</html>"),
        )
        fetcher, store, _ = build(transport)

        await fetcher.fetch(REF)
        await fetcher.fetch(REF)

        assert len(store.rows) == 2

    async def test_retention_prunes_to_the_newest_n(self) -> None:
        pages = (httpx.Response(200, text=f"<html>v{i}</html>") for i in range(6))
        transport, _ = responder(*pages)
        fetcher, store, _ = build(transport)

        for _ in range(6):
            await fetcher.fetch(REF)

        assert len(store.rows) == 3
        assert store.rows[-1][1].content_hash == content_hash("<html>v5</html>")


class TestConditionalRequests:
    async def test_stored_etag_is_offered_back(self) -> None:
        transport, seen = responder(
            httpx.Response(200, text="<html>one</html>", headers={"ETag": 'W/"abc"'}),
            httpx.Response(304),
        )
        fetcher, store, _ = build(transport)

        await fetcher.fetch(REF)
        second = await fetcher.fetch(REF)

        assert seen[1].headers["If-None-Match"] == 'W/"abc"'
        assert second.outcome is FetchOutcome.UNCHANGED
        assert len(store.rows) == 1

    async def test_falls_back_to_if_modified_since_without_an_etag(self) -> None:
        transport, seen = responder(
            httpx.Response(200, text="<html>one</html>"),  # no ETag header
            httpx.Response(304),
        )
        fetcher, _, _ = build(transport)

        await fetcher.fetch(REF)
        await fetcher.fetch(REF)

        assert "If-None-Match" not in seen[1].headers
        assert "If-Modified-Since" in seen[1].headers

    async def test_first_request_sends_no_validator(self) -> None:
        transport, seen = responder(httpx.Response(200, text="x"))
        fetcher, _, _ = build(transport)

        await fetcher.fetch(REF)

        assert "If-None-Match" not in seen[0].headers
        assert "If-Modified-Since" not in seen[0].headers


class TestPoliteness:
    async def test_crawl_delay_is_enforced_between_requests(self) -> None:
        transport, _ = responder(
            httpx.Response(200, text="a"), httpx.Response(200, text="b")
        )
        fetcher, _, clock = build(transport)

        await fetcher.fetch(REF)
        await fetcher.fetch(ProductRef(url=URL + "?x=1", external_id="other"))

        assert clock.slept == [10.0], "second request must wait the full crawl delay"

    async def test_no_delay_before_the_very_first_request(self) -> None:
        transport, _ = responder(httpx.Response(200, text="a"))
        fetcher, _, clock = build(transport)

        await fetcher.fetch(REF)

        assert clock.slept == []

    async def test_time_already_spent_counts_against_the_delay(self) -> None:
        """Parsing and image work between fetches is not charged twice."""
        transport, _ = responder(httpx.Response(200, text="a"), httpx.Response(200, text="b"))
        fetcher, _, clock = build(transport)

        await fetcher.fetch(REF)
        clock.now += 7.0  # caller spent 7s doing other work
        await fetcher.fetch(ProductRef(url=URL + "?x=1", external_id="other"))

        assert clock.slept == [pytest.approx(3.0)]

    async def test_user_agent_identifies_us(self) -> None:
        transport, seen = responder(httpx.Response(200, text="a"))
        fetcher, _, _ = build(transport)

        await fetcher.fetch(REF)

        assert seen[0].headers["User-Agent"] == POLITENESS.user_agent


class TestFailureHandling:
    @pytest.mark.parametrize("status", [404, 410])
    async def test_withdrawn_products_are_not_retried(self, status: int) -> None:
        """Each retry burns a 10-second slot for a page that will never return."""
        transport, seen = responder(httpx.Response(status))
        fetcher, _, _ = build(transport)

        result = await fetcher.fetch(REF)

        assert result.outcome is FetchOutcome.GONE
        assert len(seen) == 1

    async def test_server_errors_are_retried_then_give_up(self) -> None:
        transport, seen = responder(httpx.Response(503))
        fetcher, store, _ = build(transport)

        result = await fetcher.fetch(REF)

        assert result.outcome is FetchOutcome.FAILED
        assert len(seen) == 4, "max_attempts default"
        assert store.rows == []

    async def test_transient_error_then_success(self) -> None:
        transport, _ = responder(httpx.Response(503), httpx.Response(200, text="recovered"))
        fetcher, store, _ = build(transport)

        result = await fetcher.fetch(REF)

        assert result.outcome is FetchOutcome.STORED
        assert len(store.rows) == 1

    async def test_transport_failure_is_retried(self) -> None:
        attempts = {"n": 0}

        def handle(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise httpx.ConnectTimeout("boom", request=request)
            return httpx.Response(200, text="finally")

        fetcher, _store, _ = build(httpx.MockTransport(handle))

        result = await fetcher.fetch(REF)

        assert result.outcome is FetchOutcome.STORED
        assert attempts["n"] == 3

    async def test_client_error_is_not_retried(self) -> None:
        transport, seen = responder(httpx.Response(403))
        fetcher, _, _ = build(transport)

        result = await fetcher.fetch(REF)

        assert result.outcome is FetchOutcome.FAILED
        assert len(seen) == 1


class TestCanonicalHashing:
    """Real evidence: two live fetches of PCF-54, ten seconds apart.

    The bodies are the same length and differ on exactly three lines — a BigCommerce
    BODL analytics blob, its timestamp/visit_id, and Cloudflare's challenge params. If
    the hash saw raw bytes, every product would look changed on every crawl.
    """

    @staticmethod
    def _bodies() -> tuple[str, str]:
        from tests.conftest import fixture_dir

        return (
            (fixture_dir("amaco") / "volatile-pcf-54-fetch-a.html").read_text(),
            (fixture_dir("amaco") / "volatile-pcf-54-fetch-b.html").read_text(),
        )

    def test_raw_bytes_really_do_differ(self) -> None:
        import hashlib

        a, b = self._bodies()
        assert hashlib.sha256(a.encode()).digest() != hashlib.sha256(b.encode()).digest()

    def test_canonical_hash_is_stable_across_fetches(self) -> None:
        a, b = self._bodies()
        assert content_hash(a, VOLATILE_PATTERNS) == content_hash(b, VOLATILE_PATTERNS)

    def test_default_patterns_strip_nothing(self) -> None:
        """A source that forgets its volatile_patterns must fail loud — every fetch
        looks byte-new — rather than silently inherit BigCommerce's regexes."""
        a, b = self._bodies()
        assert content_hash(a) != content_hash(b)

    def test_canonicalisation_leaves_product_data_alone(self) -> None:
        """It must strip analytics, not content — the JSON-LD block has to survive."""
        from glaze_etl.core.fetcher import canonicalize_for_hash

        a, _ = self._bodies()
        canonical = canonicalize_for_hash(a, VOLATILE_PATTERNS)
        assert "PCF-54 Flux Blossom" in canonical
        assert "PC-70_over_PCF-54_16M_Vase_Website" in canonical
        assert "window.bodl" not in canonical
        assert "__CF$cv$params" not in canonical

    def test_a_real_content_change_still_registers(self) -> None:
        a, _ = self._bodies()
        renamed = a.replace("Flux Blossom", "Flux Renamed")
        assert content_hash(a, VOLATILE_PATTERNS) != content_hash(renamed, VOLATILE_PATTERNS)

    async def test_repeat_fetch_of_a_noisy_page_writes_one_row(self) -> None:
        """End to end: the exact scenario that stored a duplicate before canonicalisation."""
        a, b = self._bodies()
        transport, _ = responder(httpx.Response(200, text=a), httpx.Response(200, text=b))
        fetcher, store, _ = build(transport, volatile_patterns=VOLATILE_PATTERNS)

        first = await fetcher.fetch(REF)
        second = await fetcher.fetch(REF)

        assert first.outcome is FetchOutcome.STORED
        assert second.outcome is FetchOutcome.UNCHANGED
        assert len(store.rows) == 1

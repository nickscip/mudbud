"""The CLI itself: every command's happy path and every refusal it can print.

Nothing here touches Postgres or the network. Commands are driven through typer's
`CliRunner`, HTTP is served by an `httpx.MockTransport` injected over `cli.httpx`, and the
`core/` collaborators the commands import by name are monkeypatched on the `cli` module.

Two things make this cheap. `FakeAdapter` sets `crawl_delay_s` to zero, so a multi-product
`sync` runs instantly instead of waiting AMACO's mandated ten seconds per page; and
`ingest_product` is an `AsyncMock`, so the pipeline stages have their own tests rather than
being re-run here.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import httpx
import psycopg
import pytest
from typer.testing import CliRunner

import glaze_etl.cli as cli
from glaze_etl.core.blob_store import SupabaseBlobStore
from glaze_etl.core.config import Settings
from glaze_etl.core.db import BlobOperationAlreadyRunning, BlobOperationLockLost
from glaze_etl.core.loader import LoadStats
from glaze_etl.core.models import Politeness, ProductRef
from glaze_etl.core.store import InMemorySnapshotStore
from glaze_etl.sources.amaco.adapter import AmacoAdapter
from tests.conftest import fixture_dir, fixture_path, snapshot_for

LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def _settings(**overrides: str) -> Settings:
    """Explicit settings — never the developer's `etl/.env`, which points at production."""
    values: dict[str, str] = {
        "database_url": LOCAL_DB,
        "supabase_url": "http://127.0.0.1:54321",
        "secret_key": "test-secret",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def _run(*args: str) -> object:
    return CliRunner().invoke(cli.app, list(args))


def _use_transport(monkeypatch: pytest.MonkeyPatch, transport: httpx.MockTransport) -> None:
    """`cli.py` builds its `httpx.AsyncClient` inline, so the module attribute is the seam."""
    monkeypatch.setattr(
        cli,
        "httpx",
        SimpleNamespace(AsyncClient=lambda **kw: httpx.AsyncClient(transport=transport, **kw)),
    )


def _responder(*responses: httpx.Response) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    queue = list(responses)

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return queue.pop(0) if queue else responses[-1]

    return httpx.MockTransport(handle), seen


def _fixture_transport(slug: str) -> httpx.MockTransport:
    body = fixture_path(f"product-{slug}").read_text()
    return httpx.MockTransport(lambda _request: httpx.Response(200, text=body))


def _sitemap_transport() -> httpx.MockTransport:
    xml = (fixture_dir("amaco") / "sitemap-products-1.xml").read_text()

    def handle(request: httpx.Request) -> httpx.Response:
        if "page=1" in str(request.url):
            return httpx.Response(200, text=xml)
        return httpx.Response(404)

    return httpx.MockTransport(handle)


class FakeAdapter(AmacoAdapter):
    """AMACO's parsing and URL shapes, with discovery scripted and the delay removed."""

    politeness = Politeness(crawl_delay_s=0.0, user_agent="mudbud-glaze-etl/0.1 (test)")

    def __init__(self, slugs: list[str]) -> None:
        super().__init__()
        self._slugs = slugs

    async def discover(self, since: datetime | None = None) -> AsyncIterator[ProductRef]:
        for slug in self._slugs:
            yield self.product_ref(slug)


class _Refusing:
    """A context manager whose `__enter__` raises, standing in for a lock that is taken."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    def __enter__(self) -> None:
        raise self._error

    def __exit__(self, *exc: object) -> bool:
        return False


# --------------------------------------------------------------------------- discover


def test_discover_lists_glaze_slugs_only_up_to_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = _sitemap_transport()
    monkeypatch.setattr(
        cli, "adapter_for", lambda _k: AmacoAdapter(client=httpx.AsyncClient(transport=transport))
    )

    result = _run("discover", "--limit", "3")

    assert result.exit_code == 0, result.output
    assert "o-20-bluebell" in result.output
    assert "3 glaze products (limit 3)" in result.output
    assert "elmt-coil-ex-247sf-230v-2p-ctr" not in result.output, "equipment is not a glaze"


def test_discover_reports_a_short_catalog_without_reaching_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cli, "adapter_for", lambda _k: FakeAdapter(["pc-1-a", "pc-2-b"]))

    result = _run("discover")

    assert result.exit_code == 0, result.output
    assert "2 glaze products (limit 20)" in result.output


# ------------------------------------------------------------------------------ crawl


def test_crawl_dry_run_prints_the_parsed_report(monkeypatch: pytest.MonkeyPatch) -> None:
    """`o-20-bluebell` is the fixture that exercises all three confidence colours and
    leaves tokens the grammar refuses to guess at."""
    monkeypatch.setattr(cli, "Settings", _settings)
    _use_transport(monkeypatch, _fixture_transport("o-20-bluebell"))
    monkeypatch.setattr(
        cli, "db_connect", Mock(side_effect=AssertionError("a dry run must not connect"))
    )

    result = _run("crawl", "o-20-bluebell", "--dry-run")

    assert result.exit_code == 0, result.output
    assert "O-20" in result.output
    assert "badges" in result.output
    assert "[high" in result.output
    assert "[medium" in result.output
    assert "[low" in result.output
    assert "unresolved: ['gamble']" in result.output


def test_crawl_dry_run_reports_every_fact_the_grammar_can_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PCF-54 is the only fixture whose images carry a subject, a base, a combination, a
    cone, a clay body and a form all at once."""
    monkeypatch.setattr(cli, "Settings", _settings)
    _use_transport(monkeypatch, _fixture_transport("pcf-54-flux-blossom"))

    result = _run("crawl", "pcf-54-flux-blossom", "--dry-run")

    assert result.exit_code == 0, result.output
    for bit in ("subject=", "over=", "combo=", "cone=", "clay=", "form="):
        assert bit in result.output, bit


def test_crawl_discovers_and_skips_what_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, "Settings", _settings)
    monkeypatch.setattr(cli, "adapter_for", lambda _k: FakeAdapter(["pc-1-a", "pc-2-b"]))
    transport, seen = _responder(httpx.Response(404))
    _use_transport(monkeypatch, transport)

    result = _run("crawl", "--limit", "1", "--dry-run")

    assert result.exit_code == 0, result.output
    assert len(seen) == 1, "--limit 1 must stop discovery after one ref"
    assert "badges" not in result.output, "a 404 is skipped, not reported"


def test_crawl_discovers_the_whole_short_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    """Under the limit, discovery runs to exhaustion. `lg-65-amber` also carries the one
    fixture image whose filename names no subject glaze."""

    def handle(request: httpx.Request) -> httpx.Response:
        if "gone" in request.url.path:
            return httpx.Response(404)
        return httpx.Response(200, text=fixture_path("product-lg-65-amber").read_text())

    monkeypatch.setattr(cli, "Settings", _settings)
    monkeypatch.setattr(cli, "adapter_for", lambda _k: FakeAdapter(["lg-65-amber", "pc-2-gone"]))
    _use_transport(monkeypatch, httpx.MockTransport(handle))

    result = _run("crawl", "--dry-run")

    assert result.exit_code == 0, result.output
    assert "LG-65" in result.output
    assert "[low   ] line_chart\n" in result.output, "an image whose filename names no glaze"


def test_crawl_writes_through_postgres_and_closes_the_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cli, "Settings", _settings)
    conn = Mock()
    connect = Mock(return_value=conn)
    monkeypatch.setattr(cli, "db_connect", connect)
    store = InMemorySnapshotStore()
    store_factory = Mock(side_effect=lambda _conn: store)
    monkeypatch.setattr(cli, "PostgresSnapshotStore", store_factory)
    _use_transport(monkeypatch, _fixture_transport("pc-20-blue-rutile"))

    result = _run("crawl", "pc-20-blue-rutile")

    assert result.exit_code == 0, result.output
    connect.assert_called_once_with(LOCAL_DB, autocommit=True)
    store_factory.assert_called_once_with(conn)
    assert len(store.rows) == 1
    conn.close.assert_called_once_with()


# ---------------------------------------------------------------------------- reparse


def _wire_reparse(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, "Settings", _settings)
    monkeypatch.setattr(cli, "db_connect", lambda *_a, **_k: nullcontext(Mock()))
    store = Mock()
    store.newest_per_url.return_value = [snapshot_for("pc-30-temmoku")]
    monkeypatch.setattr(cli, "PostgresSnapshotStore", lambda _conn: store)


def test_reparse_counts_confidences_and_says_it_wrote_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire_reparse(monkeypatch)

    result = _run("reparse")

    assert result.exit_code == 0, result.output
    assert "reparsed 1 products, 3 images" in result.output
    assert "dry run: nothing written" in result.output


def test_reparse_without_dry_run_omits_the_disclaimer(monkeypatch: pytest.MonkeyPatch) -> None:
    _wire_reparse(monkeypatch)

    result = _run("reparse", "--no-dry-run")

    assert result.exit_code == 0, result.output
    assert "dry run: nothing written" not in result.output


# ------------------------------------------------------------------------------- load


def _wire_load(
    monkeypatch: pytest.MonkeyPatch, *, snapshots: list[object], known: set[str] | None = None
) -> SimpleNamespace:
    monkeypatch.setattr(cli, "Settings", _settings)
    lock = Mock()
    monkeypatch.setattr(cli, "exclusive_blob_operation", lambda *_a, **_k: nullcontext(lock))
    conn = Mock()
    monkeypatch.setattr(cli, "db_connect", lambda *_a, **_k: nullcontext(conn))

    store = Mock()
    store.newest_per_url.return_value = snapshots
    monkeypatch.setattr(cli, "PostgresSnapshotStore", lambda _conn: store)

    loader = Mock()
    loader.stats = LoadStats(glazes=4, images=9, appearances=12, issues=1)
    loader.inherit_line_cones.return_value = 2
    loader.link_layering.return_value = 3
    monkeypatch.setattr(cli, "Loader", lambda *_a: loader)
    monkeypatch.setattr(cli, "normalizer_for", Mock())
    monkeypatch.setattr(cli, "load_color_namer", Mock())
    monkeypatch.setattr(cli, "stored_object_keys", lambda *_a: known if known else set())

    blobs = Mock()
    blob_store_for = Mock(return_value=blobs)
    monkeypatch.setattr(cli, "blob_store_for", blob_store_for)
    media_cls = Mock()
    monkeypatch.setattr(cli, "MediaProcessor", media_cls)
    ingest = AsyncMock()
    monkeypatch.setattr(cli, "ingest_product", ingest)
    _use_transport(monkeypatch, httpx.MockTransport(lambda _r: httpx.Response(200, text="x")))

    return SimpleNamespace(
        lock=lock,
        conn=conn,
        store=store,
        loader=loader,
        blobs=blobs,
        blob_store_for=blob_store_for,
        media_cls=media_cls,
        ingest=ingest,
    )


def test_load_ingests_stored_snapshots_and_prints_the_stats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshot = snapshot_for("pc-20-blue-rutile")
    env = _wire_load(monkeypatch, snapshots=[snapshot], known={"m/aa/known.jpg"})

    result = _run("load", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output
    assert (
        "glazes 4  images 9  appearances 12  layering links 3  cone-inherited 2  issues 1"
        in result.output
    )
    env.ingest.assert_awaited_once()
    assert env.ingest.await_args.args[3] is None, "--no-images means no MediaProcessor"
    env.media_cls.assert_not_called()
    assert env.lock.check.call_count == 3, "before and after each ingest, and before the commit"
    env.conn.commit.assert_called_once_with()


def test_load_with_images_caches_bytes_in_the_blob_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The local directory doubles as a byte cache even when blobs go to Supabase."""
    env = _wire_load(monkeypatch, snapshots=[snapshot_for("pc-20-blue-rutile")])

    result = _run("load", "--images", "--blob-dir", str(tmp_path))

    assert result.exit_code == 0, result.output
    env.media_cls.assert_called_once()
    assert env.media_cls.call_args.args[1] is env.blobs
    assert env.media_cls.call_args.kwargs["byte_cache"] == tmp_path
    assert env.blob_store_for.call_args.kwargs["blob_dir"] == tmp_path


def test_load_refuses_a_slug_with_no_stored_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    env = _wire_load(monkeypatch, snapshots=[])

    result = _run("load", "missing-product", "--no-images")

    assert result.exit_code == 1
    assert "no stored snapshot for amaco slug: missing-product" in result.output
    env.ingest.assert_not_awaited()


# ------------------------------------------------------------- the blob-operation lock


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (
            BlobOperationAlreadyRunning("amaco"),
            "refusing: another sync, load, or gc prune is active for amaco",
        ),
        (
            BlobOperationLockLost("amaco"),
            "aborting: lost the database lock protecting blob operations for amaco",
        ),
    ],
)
def test_a_contended_or_lost_lock_stops_the_run(
    monkeypatch: pytest.MonkeyPatch, error: Exception, message: str
) -> None:
    monkeypatch.setattr(cli, "Settings", _settings)
    monkeypatch.setattr(cli, "exclusive_blob_operation", lambda *_a, **_k: _Refusing(error))

    result = _run("sync", "pc-20-blue-rutile")

    assert result.exit_code == 1
    assert message in result.output


# ------------------------------------------------------------------------------- sync


def _wire_sync(
    monkeypatch: pytest.MonkeyPatch,
    transport: httpx.MockTransport,
    *,
    adapter: object | None = None,
    glaze_count: int = 0,
    reconcile: tuple[int, list[str]] = (0, []),
    unavailable_before: set[str] | None = None,
    newest_snapshot: object | None = None,
) -> SimpleNamespace:
    unavailable_before = set() if unavailable_before is None else unavailable_before
    monkeypatch.setattr(cli, "Settings", _settings)
    if adapter is not None:
        monkeypatch.setattr(cli, "adapter_for", lambda _k: adapter)
    lock = Mock()
    monkeypatch.setattr(cli, "exclusive_blob_operation", lambda *_a, **_k: nullcontext(lock))
    conn = Mock()
    monkeypatch.setattr(cli, "db_connect", lambda *_a, **_k: nullcontext(conn))

    loader = Mock()
    loader.stats = LoadStats()
    loader.inherit_line_cones.return_value = 0
    loader.link_layering.return_value = 0
    loader.glaze_count.return_value = glaze_count
    loader.reconcile_listing.return_value = reconcile
    # Membership-tested against every ref, so it has to be a real set rather than a Mock.
    # Empty by default: the recovery path has its own tests below.
    loader.unavailable_slugs.return_value = unavailable_before
    monkeypatch.setattr(cli, "Loader", lambda *_a: loader)
    monkeypatch.setattr(cli, "normalizer_for", Mock())
    monkeypatch.setattr(cli, "load_color_namer", Mock())
    monkeypatch.setattr(cli, "stored_object_keys", lambda *_a: set())
    monkeypatch.setattr(cli, "blob_store_for", Mock())
    monkeypatch.setattr(cli, "MediaProcessor", Mock())
    # The recovery path reads a stored snapshot back, which is a PostgresSnapshotStore method the
    # in-memory double does not carry, so it is attached here rather than widening the Protocol.
    store = InMemorySnapshotStore()
    store.newest = Mock(return_value=newest_snapshot)  # type: ignore[attr-defined]
    monkeypatch.setattr(cli, "PostgresSnapshotStore", lambda _conn: store)
    ingest = AsyncMock()
    monkeypatch.setattr(cli, "ingest_product", ingest)
    _use_transport(monkeypatch, transport)

    return SimpleNamespace(lock=lock, conn=conn, loader=loader, ingest=ingest, store=store)


def test_sync_of_one_slug_fetches_and_ingests_it(monkeypatch: pytest.MonkeyPatch) -> None:
    transport, seen = _responder(httpx.Response(200, text="<html>one</html>"))
    env = _wire_sync(monkeypatch, transport)

    result = _run("sync", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output
    assert "changed 1  unchanged 0  ingested 1  gone 0" in result.output
    assert len(seen) == 1
    env.ingest.assert_awaited_once()
    assert env.conn.commit.call_count == 2, "once per ingested product, once at the end"
    # A targeted run cannot speak to absences, so it never asks how many glazes exist.
    env.loader.glaze_count.assert_not_called()


def test_sync_records_a_failed_ingest_without_losing_the_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, _ = _responder(httpx.Response(200, text="<html>one</html>"))
    env = _wire_sync(monkeypatch, transport)
    env.ingest.side_effect = RuntimeError("normalizer exploded")

    result = _run("sync", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output
    assert "changed 1  unchanged 0  ingested 0" in result.output
    assert "failed 1" in result.output
    assert "failed: pc-20-blue-rutile" in result.output
    assert env.conn.commit.call_count == 2, "the snapshot is committed so reparse can retry"


def test_sync_counts_a_304_as_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    transport, _ = _responder(httpx.Response(304))
    env = _wire_sync(monkeypatch, transport)

    result = _run("sync", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output
    assert "changed 0  unchanged 1  ingested 0" in result.output
    env.ingest.assert_not_awaited()


def test_sync_reingests_an_unavailable_product_whose_page_came_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A product marked Unavailable recovers only through ingest, and ingest only runs on a
    STORED fetch. If the page returns with the bytes we already hold, the fetch is UNCHANGED
    and nothing would ever clear the marker — so the stored snapshot is replayed explicitly."""
    snapshot = snapshot_for("pc-20-blue-rutile")
    transport, _ = _responder(httpx.Response(304))
    env = _wire_sync(
        monkeypatch,
        transport,
        unavailable_before={"pc-20-blue-rutile"},
        newest_snapshot=snapshot,
    )

    result = _run("sync", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output
    env.ingest.assert_awaited_once()
    assert env.ingest.await_args.args[0] is snapshot
    env.conn.commit.assert_called()


def test_sync_leaves_an_unchanged_product_alone_when_it_is_not_marked_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The counterpart: the recovery replay must not fire for every unchanged product, or a
    steady-state weekly run would re-ingest the whole catalog it was built to skip."""
    transport, _ = _responder(httpx.Response(304))
    env = _wire_sync(monkeypatch, transport, newest_snapshot=snapshot_for("pc-20-blue-rutile"))

    result = _run("sync", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output
    env.ingest.assert_not_awaited()
    env.store.newest.assert_not_called()


def test_sync_reports_a_failed_recovery_without_stopping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, _ = _responder(httpx.Response(304))
    env = _wire_sync(
        monkeypatch,
        transport,
        unavailable_before={"pc-20-blue-rutile"},
        newest_snapshot=snapshot_for("pc-20-blue-rutile"),
    )
    env.ingest.side_effect = RuntimeError("boom")

    result = _run("sync", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output


def test_sync_skips_recovery_when_no_snapshot_was_ever_stored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, _ = _responder(httpx.Response(304))
    env = _wire_sync(
        monkeypatch,
        transport,
        unavailable_before={"pc-20-blue-rutile"},
        newest_snapshot=None,
    )

    result = _run("sync", "pc-20-blue-rutile", "--no-images")

    assert result.exit_code == 0, result.output
    env.ingest.assert_not_awaited()


def test_sync_limit_caps_discovery_and_suppresses_reconciliation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, seen = _responder(httpx.Response(200, text="<html>one</html>"))
    env = _wire_sync(
        monkeypatch, transport, adapter=FakeAdapter(["pc-1-a", "pc-2-b", "pc-3-c"]), glaze_count=3
    )

    result = _run("sync", "--limit", "1", "--no-images")

    assert result.exit_code == 0, result.output
    assert len(seen) == 1
    assert "changed 1" in result.output
    # A --limit run saw a subset by construction.
    env.loader.glaze_count.assert_not_called()


def test_sync_reconciles_a_complete_listing(monkeypatch: pytest.MonkeyPatch) -> None:
    transport, _ = _responder(httpx.Response(200, text="<html>one</html>"))
    env = _wire_sync(
        monkeypatch,
        transport,
        adapter=FakeAdapter(["pc-1-a", "pc-2-b"]),
        glaze_count=2,
        reconcile=(2, ["PC-9"]),
    )

    result = _run("sync", "--no-images")

    assert result.exit_code == 0, result.output
    env.loader.reconcile_listing.assert_called_once_with("amaco", ["pc-1-a", "pc-2-b"])
    assert "unavailable 1" in result.output
    assert "newly unavailable: PC-9" in result.output


def test_sync_excludes_a_withdrawn_product_from_the_listing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 404 is a withdrawal, not an unchanged page: it must not be counted as `unchanged`
    and must not be handed to `reconcile_listing` as still listed."""

    def handle(request: httpx.Request) -> httpx.Response:
        if "gone" in request.url.path:
            return httpx.Response(404)
        return httpx.Response(200, text="<html>one</html>")

    env = _wire_sync(
        monkeypatch,
        httpx.MockTransport(handle),
        adapter=FakeAdapter(["pc-1-a", "pc-2-gone"]),
        glaze_count=2,
        reconcile=(1, []),
    )

    result = _run("sync", "--no-images")

    assert result.exit_code == 0, result.output
    assert "changed 1  unchanged 0  ingested 1  gone 1" in result.output
    env.loader.reconcile_listing.assert_called_once_with("amaco", ["pc-1-a"])


def test_sync_skips_reconciliation_when_discovery_came_back_short(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, _ = _responder(httpx.Response(200, text="<html>one</html>"))
    env = _wire_sync(
        monkeypatch, transport, adapter=FakeAdapter(["pc-1-a"]), glaze_count=630
    )

    result = _run("sync", "--no-images")

    assert result.exit_code == 0, result.output
    env.loader.glaze_count.assert_called_once_with("amaco")
    env.loader.reconcile_listing.assert_not_called()
    assert "unavailable 0" in result.output


def test_sync_reconciles_a_brand_with_nothing_loaded_yet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`glaze_count` of 0 means there is nothing to protect, so the listing is believed."""
    transport, _ = _responder(httpx.Response(200, text="<html>one</html>"))
    env = _wire_sync(
        monkeypatch, transport, adapter=FakeAdapter(["pc-1-a"]), glaze_count=0
    )

    result = _run("sync", "--no-images")

    assert result.exit_code == 0, result.output
    env.loader.reconcile_listing.assert_called_once_with("amaco", ["pc-1-a"])


# --------------------------------------------------------------------------------- gc

OLD = datetime.now(UTC) - timedelta(days=1)


def _sha(n: int) -> str:
    return f"{n:064x}"


def _key(sha: str, prefix: str = "m") -> str:
    return f"{prefix}/{sha[:2]}/{sha}.jpg"


def _wire_gc(
    monkeypatch: pytest.MonkeyPatch,
    *,
    referenced: set[str] | Mock,
    ages: dict[str, datetime | None] | Mock,
    settings: Settings | None = None,
    blobs: object = None,
) -> SimpleNamespace:
    resolved = settings or _settings()
    monkeypatch.setattr(cli, "Settings", lambda: resolved)
    conn = Mock()
    conn.info.host = "127.0.0.1"
    conn.info.user = "postgres"
    conn.info.dbname = "postgres"
    monkeypatch.setattr(cli, "db_connection", lambda *_a, **_k: nullcontext(conn))
    lock = Mock()
    monkeypatch.setattr(cli, "exclusive_blob_operation", lambda *_a, **_k: nullcontext(lock))
    monkeypatch.setattr(
        cli,
        "referenced_shas",
        referenced if isinstance(referenced, Mock) else (lambda *_a: referenced),
    )
    monkeypatch.setattr(
        cli, "stored_object_ages", ages if isinstance(ages, Mock) else (lambda *_a: ages)
    )
    blob_store_for = Mock(return_value=blobs)
    monkeypatch.setattr(cli, "blob_store_for", blob_store_for)
    return SimpleNamespace(conn=conn, lock=lock, blob_store_for=blob_store_for)


def test_gc_reports_the_sweep_and_stops(monkeypatch: pytest.MonkeyPatch) -> None:
    kept, orphan = _sha(1), _sha(2)
    env = _wire_gc(
        monkeypatch,
        referenced={kept},
        ages={_key(kept): OLD, _key(orphan): OLD, "orig/loose.jpg": OLD},
    )

    result = _run("gc")

    assert result.exit_code == 0, result.output
    assert "database 127.0.0.1/postgres  bucket mudbud_amaco" in result.output
    assert "referenced shas 1" in result.output
    assert "bucket objects 3" in result.output
    assert "orphaned shas 1" in result.output
    assert "orphaned objects 1" in result.output
    assert "1 bucket object(s) did not parse as a managed key" in result.output
    assert "dry run: pass --prune to delete" in result.output
    env.blob_store_for.assert_not_called()


def test_gc_refuses_to_prune_without_storage_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cli, "Settings", lambda: _settings(secret_key=""))
    connect = Mock(side_effect=AssertionError("gc connected before validating its target"))
    monkeypatch.setattr(cli, "db_connection", connect)

    result = _run("gc", "--prune")

    assert result.exit_code == 1
    assert "requires SUPABASE_URL and SUPABASE_SECRET_KEY" in result.output
    connect.assert_not_called()


def test_gc_refuses_when_storage_metadata_is_unreadable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unreadable `storage.objects` is not evidence that a bucket is empty."""
    _wire_gc(
        monkeypatch,
        referenced={_sha(1)},
        ages=Mock(side_effect=psycopg.ProgrammingError("permission denied")),
    )

    result = _run("gc")

    assert result.exit_code == 1
    assert "could not read Storage object metadata" in result.output


def test_gc_refuses_to_prune_across_a_project_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sha = _sha(1)
    _wire_gc(
        monkeypatch,
        referenced={sha},
        ages={_key(sha): OLD, _key(_sha(2)): OLD},
        settings=_settings(supabase_url="https://abcdefghijkl.supabase.co"),
    )

    result = _run("gc", "--prune")

    assert result.exit_code == 1
    assert "do not identify the same Supabase project" in result.output


def test_gc_refuses_an_empty_reference_set_against_a_full_bucket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire_gc(monkeypatch, referenced=set(), ages={_key(_sha(1)): OLD})

    result = _run("gc")

    assert result.exit_code == 1
    assert "0 referenced shas against a non-empty bucket" in result.output


def test_gc_refuses_an_implausible_orphan_fraction_without_force(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shas = [_sha(i) for i in range(40)]
    _wire_gc(
        monkeypatch,
        referenced=set(shas[:35]),
        ages=dict.fromkeys((_key(s) for s in shas), OLD),
    )

    result = _run("gc", "--prune", "--allow-local-prune")

    assert result.exit_code == 1
    assert "orphan fraction exceeds the safety threshold" in result.output


def test_gc_refuses_to_prune_a_non_supabase_blob_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kept, orphan = _sha(1), _sha(2)
    _wire_gc(
        monkeypatch,
        referenced={kept},
        ages={_key(kept): OLD, _key(orphan): OLD},
        blobs=Mock(),
    )

    result = _run("gc", "--prune", "--allow-local-prune")

    assert result.exit_code == 1
    assert "--prune selected a non-Supabase blob store" in result.output


def test_gc_prune_deletes_only_orphans_that_survive_the_recheck(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The window between reading a report and passing `--prune` is open-ended, so the
    reference set is recomputed immediately before deleting."""
    kept, revived, doomed = _sha(1), _sha(2), _sha(3)
    blobs = MagicMock(spec=SupabaseBlobStore)
    env = _wire_gc(
        monkeypatch,
        referenced=Mock(side_effect=[{kept}, {kept, revived}]),
        ages={_key(kept): OLD, _key(revived): OLD, _key(doomed): OLD},
        blobs=blobs,
    )

    result = _run("gc", "--prune", "--allow-local-prune")

    assert result.exit_code == 0, result.output
    assert "orphaned objects 2" in result.output
    assert "deleted 1 object(s)" in result.output
    blobs.remove.assert_called_once_with([_key(doomed)])
    env.lock.check.assert_called_once_with()


# ----------------------------------------------------------------------------- report


def _wire_report(monkeypatch: pytest.MonkeyPatch, issues: list[tuple[str, int]]) -> None:
    monkeypatch.setattr(cli, "Settings", _settings)
    cursor = Mock()
    cursor.fetchone.return_value = (352, 900, 700, 120, 130, 8, 41)
    cursor.fetchall.return_value = issues
    conn = Mock()
    conn.execute.return_value = cursor
    monkeypatch.setattr(cli, "db_connect", lambda *_a, **_k: nullcontext(conn))


def test_report_prints_a_markdown_table_and_the_review_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire_report(monkeypatch, [("composite_unsplit", 16), ("unmapped_cone_category", 3)])

    result = _run("report")

    assert result.exit_code == 0, result.output
    assert "## Catalog" in result.output
    assert "| Glazes | 352 |" in result.output
    assert "| Open review items | 41 |" in result.output
    assert "### Review queue" in result.output
    assert "- `composite_unsplit` x 16" in result.output


def test_report_omits_the_review_queue_when_nothing_is_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire_report(monkeypatch, [])

    result = _run("report")

    assert result.exit_code == 0, result.output
    assert "| Glazes | 352 |" in result.output
    assert "### Review queue" not in result.output

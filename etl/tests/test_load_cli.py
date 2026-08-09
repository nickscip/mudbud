"""Fail-closed behavior for targeted snapshot loads."""

from __future__ import annotations

from contextlib import nullcontext
from unittest.mock import Mock

import pytest
from typer.testing import CliRunner

import glaze_etl.cli as cli
from glaze_etl.core.config import Settings
from glaze_etl.core.models import ManufacturerKey


def test_targeted_load_refuses_a_slug_without_a_stored_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        database_url="postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        supabase_url="http://127.0.0.1:54321",
        secret_key="test-secret",
    )
    monkeypatch.setattr(cli, "Settings", lambda: settings)

    operation_lock = Mock()
    conn = Mock()
    monkeypatch.setattr(
        cli,
        "_exclusive_blob_operation",
        lambda *_args, **_kwargs: nullcontext(operation_lock),
    )
    monkeypatch.setattr(cli, "db_connect", lambda *_args, **_kwargs: nullcontext(conn))

    store = Mock()
    store.newest_per_url.return_value = []
    monkeypatch.setattr(cli, "PostgresSnapshotStore", lambda _conn: store)
    normalizer = Mock(side_effect=AssertionError("loader initialized after a missing snapshot"))
    monkeypatch.setattr(cli, "normalizer_for", normalizer)

    result = CliRunner().invoke(
        cli.app,
        ["load", "missing-product", "--manufacturer", "mayco", "--no-images"],
    )

    assert result.exit_code == 1
    assert "no stored snapshot for mayco slug: missing-product" in result.output
    store.newest_per_url.assert_called_once_with(
        ManufacturerKey.MAYCO,
        ["https://www.maycocolors.com/wp-json/wc/store/v1/products?slug=missing-product"],
    )
    normalizer.assert_not_called()

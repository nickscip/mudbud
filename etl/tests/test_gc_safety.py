"""Fail-closed boundaries around the destructive GC command."""

from __future__ import annotations

from typing import cast
from unittest.mock import Mock

import psycopg
import pytest
from typer.testing import CliRunner

import glaze_etl.cli as cli
from glaze_etl.core.config import Settings
from glaze_etl.core.db import Connection, stored_object_ages


def test_storage_metadata_query_errors_propagate() -> None:
    conn = cast(Connection, Mock())
    conn.execute.side_effect = psycopg.ProgrammingError("storage.objects is unreadable")

    with pytest.raises(psycopg.ProgrammingError):
        stored_object_ages(conn, "mudbud_amaco")

    conn.rollback.assert_not_called()


def test_prune_refuses_before_connecting_without_storage_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        database_url="postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        supabase_url="http://127.0.0.1:54321",
        secret_key="",
    )
    monkeypatch.setattr(cli, "Settings", lambda: settings)
    connect = Mock(side_effect=AssertionError("gc connected before validating its target"))
    monkeypatch.setattr(cli, "db_connection", connect)

    result = CliRunner().invoke(cli.app, ["gc", "--prune"])

    assert result.exit_code == 1
    assert "requires SUPABASE_URL and SUPABASE_SECRET_KEY" in result.output
    connect.assert_not_called()

"""Configuration binding, including the two mistakes that already bit once."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from glaze_etl.core.config import ENV_FILE, Settings


class TestEnvFileLocation:
    def test_env_file_is_anchored_to_the_package_not_cwd(self) -> None:
        """A bare ".env" resolves against the working directory, so the pipeline read config
        when invoked from etl/ and silently found none from the repo root — and would have
        preferred a stray root .env over the real one."""
        assert ENV_FILE.is_absolute()
        assert ENV_FILE.parent.name == "etl"
        assert ENV_FILE.name == ".env"

    def test_settings_load_identically_from_any_directory(self, tmp_path: Path) -> None:
        original = Path.cwd()
        try:
            os.chdir(tmp_path)
            from_elsewhere = Settings()
        finally:
            os.chdir(original)
        assert from_elsewhere.storage_bucket_prefix == Settings().storage_bucket_prefix


class TestKeyNames:
    def test_secret_key_binds_from_the_dashboard_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Supabase renamed service_role to "secret key"; the variable matches the dashboard."""
        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_example")
        assert Settings(_env_file=None).secret_key == "sb_secret_example"

    def test_no_glaze_etl_prefix_survives(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GLAZE_ETL_SUPABASE_URL", "https://wrong.example")
        assert Settings(_env_file=None).supabase_url == ""

    def test_redacted_hides_both_credentials(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_shouldnotappear")
        monkeypatch.setenv(
            "SUPABASE_DB_URL", "postgresql://postgres:hunter2@db.example/postgres"
        )
        dumped = str(Settings(_env_file=None).redacted())
        assert "shouldnotappear" not in dumped
        assert "hunter2" not in dumped


class TestBucketDerivation:
    def test_bucket_is_per_manufacturer(self) -> None:
        settings = Settings(_env_file=None)
        assert settings.bucket_for("amaco") == "mudbud_amaco"
        assert settings.bucket_for("mayco") == "mudbud_mayco"

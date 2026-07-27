"""Runtime configuration, read from the environment.

Secrets never reach the repo. Local development points at the Supabase CLI's own
Postgres; CI and the Temporal worker get the hosted values injected.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="GLAZE_ETL_", env_file=".env", extra="ignore"
    )

    database_url: str = Field(
        default="postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        description="Defaults to the port `supabase start` binds locally.",
    )

    supabase_url: str = ""
    supabase_service_key: str = ""
    storage_bucket: str = "glaze-images"

    snapshot_retention: int = Field(
        default=3,
        ge=1,
        description=(
            "How many raw_snapshots to keep per URL. A weekly full crawl adds ~22MB "
            "per pass against Supabase's 500MB tier, so this is not optional."
        ),
    )

    request_timeout_s: float = 45.0
    max_attempts: int = 4

    blob_dir: Path = Field(
        default=Path("./.blobs"),
        description="Where cached images go until the Supabase bucket is wired up.",
    )

    # 127.0.0.1, not "localhost": on this machine a Docker listener also holds *:7233 on
    # IPv6, so resolving through localhost can land on the wrong process and fail with a
    # broken pipe. Pinning IPv4 removes the ambiguity.
    temporal_address: str = "127.0.0.1:7233"
    temporal_namespace: str = "default"

    def redacted(self) -> dict[str, str]:
        """For logging a run's configuration without leaking credentials."""
        safe = self.model_dump()
        for key in ("database_url", "supabase_service_key"):
            if safe.get(key):
                safe[key] = "***"
        return {k: str(v) for k, v in safe.items()}

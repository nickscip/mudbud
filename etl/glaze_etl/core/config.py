"""Runtime configuration, read from the environment.

Secrets never reach the repo. Local development points at the Supabase CLI's own Postgres;
CI and the Temporal worker get the hosted values injected.

Variable names are set per field rather than by a shared prefix, because the two groups
belong to different systems: everything Supabase owns is `SUPABASE_*`, and the pipeline's
own knobs are unprefixed. A single `env_prefix` cannot express that split.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", populate_by_name=True
    )

    # ------------------------------------------------------------------------- Supabase
    database_url: str = Field(
        default="postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        alias="SUPABASE_DB_URL",
        description="Defaults to the port `supabase start` binds locally.",
    )

    supabase_url: str = Field(default="", alias="SUPABASE_URL")

    service_key: str = Field(
        default="",
        alias="SUPABASE_SERVICE_KEY",
        description=(
            "Service role, not anon: the pipeline writes. This key bypasses row-level "
            "security entirely, so it is treated like a database password and never "
            "reaches the app."
        ),
    )

    storage_bucket: str = Field(default="product-images", alias="SUPABASE_STORAGE_BUCKET")

    # ------------------------------------------------------------------------- pipeline
    snapshot_retention: int = Field(
        default=3,
        ge=1,
        alias="SNAPSHOT_RETENTION",
        description=(
            "How many raw_snapshots to keep per URL. A weekly full crawl adds ~22MB per "
            "pass against Supabase's 500MB tier, so this is not optional."
        ),
    )

    request_timeout_s: float = Field(default=45.0, alias="REQUEST_TIMEOUT_S")
    max_attempts: int = Field(default=4, alias="MAX_ATTEMPTS")

    blob_dir: Path = Field(
        default=Path("./.blobs"),
        alias="BLOB_DIR",
        description="Where images cache when no Supabase credentials are configured.",
    )

    # ------------------------------------------------------------------------- Temporal
    # 127.0.0.1, not "localhost": on this machine a Docker listener also holds *:7233 on
    # IPv6, so resolving through localhost can land on the wrong process and fail with a
    # broken pipe. Pinning IPv4 removes the ambiguity.
    temporal_address: str = Field(default="127.0.0.1:7233", alias="TEMPORAL_ADDRESS")
    temporal_namespace: str = Field(default="default", alias="TEMPORAL_NAMESPACE")

    def redacted(self) -> dict[str, str]:
        """For logging a run's configuration without leaking credentials."""
        safe = self.model_dump()
        for key in ("database_url", "service_key"):
            if safe.get(key):
                safe[key] = "***"
        return {k: str(v) for k, v in safe.items()}

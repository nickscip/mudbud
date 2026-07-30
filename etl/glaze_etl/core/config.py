"""Runtime configuration, read from the environment.

Secrets never reach the repo. Local development points at the Supabase CLI's own Postgres;
CI and the scheduled sync get the hosted values injected from repo secrets.

Variable names are set per field rather than by a shared prefix, because the two groups
belong to different systems: everything Supabase owns is `SUPABASE_*`, and the pipeline's
own knobs are unprefixed. A single `env_prefix` cannot express that split.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchored to the package, not the working directory. A bare ".env" is resolved against CWD,
# so `glaze-etl load` picked up config when run from etl/ and silently found none when run
# from the repo root — and would have read a stray root .env in preference to the real one.
# Configuration must not depend on where the command was typed.
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE, extra="ignore", populate_by_name=True
    )

    # ------------------------------------------------------------------------- Supabase
    database_url: str = Field(
        default="postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        alias="SUPABASE_DB_URL",
        description="Defaults to the port `supabase start` binds locally.",
    )

    supabase_url: str = Field(default="", alias="SUPABASE_URL")

    secret_key: str = Field(
        default="",
        alias="SUPABASE_SECRET_KEY",
        description=(
            "Supabase's `sb_secret_...` key — what the dashboard now calls the *secret* key, "
            "formerly `service_role`. Named to match what you actually see in Settings > API. "
            "It bypasses row-level security entirely, so it is treated like a database "
            "password and never reaches the app, which uses the publishable key instead."
        ),
    )

    storage_bucket_prefix: str = Field(
        default="mudbud",
        alias="SUPABASE_STORAGE_BUCKET_PREFIX",
        description=(
            "Buckets are one per manufacturer, named `<prefix>_<manufacturer>` — so "
            "`mudbud_amaco`. Derived rather than configured so adding a second source cannot "
            "silently write its images into the first one's bucket."
        ),
    )

    def bucket_for(self, manufacturer: str) -> str:
        """`amaco` -> `mudbud_amaco`."""
        return f"{self.storage_bucket_prefix}_{manufacturer}"

    # ------------------------------------------------------------------------- pipeline
    snapshot_retention: int = Field(
        default=1,
        ge=1,
        alias="SNAPSHOT_RETENTION",
        description=(
            "How many raw_snapshots to keep per URL. Reparse only ever reads the newest per "
            "URL, so keeping more buys history rather than capability — measured at ~26MB for "
            "the full corpus at 1, against Supabase's 500MB free tier."
        ),
    )

    request_timeout_s: float = Field(default=45.0, alias="REQUEST_TIMEOUT_S")
    max_attempts: int = Field(default=4, alias="MAX_ATTEMPTS")

    blob_dir: Path = Field(
        default=Path("./.blobs"),
        alias="BLOB_DIR",
        description="Where images cache when no Supabase credentials are configured.",
    )

    def redacted(self) -> dict[str, str]:
        """For logging a run's configuration without leaking credentials."""
        safe = self.model_dump()
        for key in ("database_url", "secret_key"):
            if safe.get(key):
                safe[key] = "***"
        return {k: str(v) for k, v in safe.items()}

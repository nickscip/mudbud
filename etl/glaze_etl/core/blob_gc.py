"""Deciding what a Storage bucket holds that no `glaze_images` row still cites.

Pure planning logic only — no I/O, no network, no database. `cli.py`'s `gc` command is
the only caller that turns this module's classification into an actual deletion.

Two separate safety margins exist here because deletion is irreversible and this repo
has already seen a local-database/hosted-bucket mismatch cause real damage (see
`AGENTS.md`'s Mayco-sync anecdote): `plan_blob_sweep`'s per-object minimum age closes the
seconds-scale window between a blob's upload and the database row that cites it
committing (`media.py` uploads before `pipeline.py`'s `upsert_image` commits), and
`recheck_orphans` closes the open-ended window between a human reading a report and
choosing to pass `--prune`.

The CLI additionally holds a database transaction-level advisory lock shared with `load`
and `sync`; the pure recheck here is defense in depth rather than an attempted substitute
for excluding concurrent reference writers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlparse

from glaze_etl.core import media

_SHARD_RE = re.compile(r"[0-9a-f]{2}")
_FILENAME_RE = re.compile(r"([0-9a-f]{64})\.jpg")
_STORAGE_PROJECT_RE = re.compile(r"^([a-z0-9]+)\.supabase\.co$")
_DIRECT_DB_PROJECT_RE = re.compile(r"^db\.([a-z0-9]+)\.supabase\.co$")
_POOLER_DB_HOST_RE = re.compile(r"^[a-z0-9-]+\.pooler\.supabase\.com$")
_POOLED_DB_USER_RE = re.compile(r"^postgres\.([a-z0-9]+)$")
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def database_matches_storage_project(
    database_host: str | None,
    database_user: str | None,
    storage_url: str,
    *,
    allow_local: bool = False,
) -> bool:
    """Whether the DB connection and Storage URL identify the same Supabase project.

    Hosted direct connections encode the project ref in
    `db.<ref>.supabase.co`; transaction-pooler connections encode it in the
    `postgres.<ref>` username, but only on a recognized Supabase pooler host. Local Supabase
    ports do not carry a shared project identity, so loopback endpoints match only after the
    caller records an explicit local-prune acknowledgement. Anything custom or unrecognized
    fails closed because this gates irreversible deletion, not ordinary reads or uploads.
    """
    storage_host = urlparse(storage_url).hostname
    if storage_host is None:
        return False
    normalized_storage_host = storage_host.lower()
    normalized_database_host = (database_host or "").lower()
    if normalized_storage_host in _LOCAL_HOSTS:
        return allow_local and normalized_database_host in _LOCAL_HOSTS

    storage_match = _STORAGE_PROJECT_RE.fullmatch(normalized_storage_host)
    if storage_match is None:
        return False
    storage_project = storage_match.group(1)

    direct_match = _DIRECT_DB_PROJECT_RE.fullmatch(normalized_database_host)
    if direct_match is not None and direct_match.group(1) == storage_project:
        return True
    if _POOLER_DB_HOST_RE.fullmatch(normalized_database_host) is None:
        return False
    user_match = _POOLED_DB_USER_RE.fullmatch((database_user or "").lower())
    return user_match is not None and user_match.group(1) == storage_project


def sha_from_key(key: str) -> str | None:
    """The sha256 a bucket key encodes, or `None` if the shape is not one of ours.

    Requires exactly three path segments `{prefix}/{shard}/{filename}`: `prefix` must be
    one of `media.DERIVATIVES`' keys, `filename` must fullmatch a lowercase 64-character
    hex digest followed by `.jpg` (`hashlib.hexdigest()` never produces uppercase, so an
    uppercase filename is by construction not one of ours), and `shard` must
    independently fullmatch two lowercase hex characters and equal the digest's own first
    two. Anything else — including a bare `orig/...` key, which should only ever exist in
    the local byte cache, never the bucket — returns `None` and is routed to
    `unexpected_keys`, never eligible for deletion.
    """
    parts = key.split("/")
    if len(parts) != 3:
        return None
    prefix, shard, filename = parts
    if prefix not in media.DERIVATIVES:
        return None
    if not _SHARD_RE.fullmatch(shard):
        return None
    match = _FILENAME_RE.fullmatch(filename)
    if match is None:
        return None
    sha = match.group(1)
    if shard != sha[:2]:
        return None
    return sha


@dataclass(frozen=True)
class BlobSweep:
    orphaned_keys: frozenset[str]
    orphaned_shas: frozenset[str]
    unexpected_keys: frozenset[str]
    recent_shas: frozenset[str]
    """Sha groups that would be orphaned, but held back this run because at least one of
    their keys is younger than `min_age` or has an unknown (null) creation time."""
    referenced_sha_count: int
    bucket_key_count: int


def plan_blob_sweep(
    referenced: set[str],
    bucket_object_ages: dict[str, datetime | None],
    *,
    now: datetime,
    min_age: timedelta = timedelta(minutes=60),
) -> BlobSweep:
    """Classify every bucket key: still referenced, orphaned, too recent to trust, or
    unparseable.

    Groups parsed bucket keys by the sha they encode. A sha-group is orphaned only when
    its sha is absent from `referenced` AND every key in the group is at least `min_age`
    old as of `now`. A group with any key younger than that, or with an unknown (`None`)
    age — `storage.objects.created_at` is Storage's own schema, not this repo's, so its
    nullability is not this codebase's to assume away — is excluded from `orphaned_keys`
    for this run and reported in `recent_shas` instead. `min_age`'s default carries wide
    margin over the gap it actually defends: media upload to database commit is normally
    seconds, not the run-scale window a whole crawl takes.
    """
    unexpected_keys: set[str] = set()
    by_sha: dict[str, list[str]] = {}
    for key in bucket_object_ages:
        sha = sha_from_key(key)
        if sha is None:
            unexpected_keys.add(key)
            continue
        by_sha.setdefault(sha, []).append(key)

    orphaned_keys: set[str] = set()
    orphaned_shas: set[str] = set()
    recent_shas: set[str] = set()
    for sha, keys in by_sha.items():
        if sha in referenced:
            continue
        ages = [bucket_object_ages[key] for key in keys]
        if any(age is None or now - age < min_age for age in ages):
            recent_shas.add(sha)
            continue
        orphaned_shas.add(sha)
        orphaned_keys.update(keys)

    return BlobSweep(
        orphaned_keys=frozenset(orphaned_keys),
        orphaned_shas=frozenset(orphaned_shas),
        unexpected_keys=frozenset(unexpected_keys),
        recent_shas=frozenset(recent_shas),
        referenced_sha_count=len(referenced),
        bucket_key_count=len(bucket_object_ages),
    )


def recheck_orphans(orphaned_keys: frozenset[str], newly_referenced: set[str]) -> frozenset[str]:
    """Drop any key whose sha has become referenced since the report was computed.

    A second, pure safety net for the open-ended window between a human reading `gc`'s
    report and choosing `--prune` — `plan_blob_sweep`'s age gate only bounds the
    upload-to-commit gap, not how long a report sits unread before someone acts on it.
    """
    return frozenset(key for key in orphaned_keys if sha_from_key(key) not in newly_referenced)


def reference_set_looks_wrong(referenced_sha_count: int, bucket_key_count: int) -> bool:
    """True only when the reference set is empty but the bucket is not — the shape a
    wrong `SUPABASE_DB_URL`/bucket pairing produces. False when both are empty: a
    brand-new, never-synced manufacturer must not trip a refusal."""
    return referenced_sha_count == 0 and bucket_key_count > 0


def exceeds_safety_threshold(
    orphaned_key_count: int,
    bucket_key_count: int,
    max_fraction: float = 0.1,
    min_bucket_size: int = 40,
) -> bool:
    """True when the orphan fraction is implausibly high for a bucket large enough that
    the fraction means something. Ignored below `min_bucket_size` so a small or
    brand-new bucket never nuisance-trips it regardless of fraction."""
    if bucket_key_count < min_bucket_size:
        return False
    return orphaned_key_count / bucket_key_count > max_fraction

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
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from glaze_etl.core import media

_SHARD_RE = re.compile(r"[0-9a-f]{2}")
_FILENAME_RE = re.compile(r"([0-9a-f]{64})\.jpg")


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

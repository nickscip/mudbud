"""Pure orphan-sweep planning logic. No database, no network, no filesystem."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

from glaze_etl.core.blob_gc import (
    exceeds_safety_threshold,
    plan_blob_sweep,
    recheck_orphans,
    reference_set_looks_wrong,
    sha_from_key,
)
from glaze_etl.core.media import DERIVATIVES

NOW = datetime(2026, 8, 9, 12, 0, tzinfo=UTC)


def sha(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()


def keys_for(digest: str) -> dict[str, str]:
    """Every rendition key for one sha, keyed by prefix."""
    return {prefix: f"{prefix}/{digest[:2]}/{digest}.jpg" for prefix in DERIVATIVES}


class TestShaFromKey:
    def test_accepts_every_real_derivative_prefix(self) -> None:
        digest = sha("accepted")
        for prefix, key in keys_for(digest).items():
            assert sha_from_key(key) == digest, prefix

    def test_rejects_a_bare_orig_key(self) -> None:
        digest = sha("orig-only")
        assert sha_from_key(f"orig/{digest[:2]}/{digest}.jpg") is None

    def test_rejects_a_shard_sha_mismatch(self) -> None:
        digest = sha("mismatch")
        assert sha_from_key(f"l/ff/{digest}.jpg") is None

    def test_rejects_a_too_short_digest(self) -> None:
        short = sha("short")[:63]
        assert sha_from_key(f"l/{short[:2]}/{short}.jpg") is None

    def test_rejects_a_too_long_digest(self) -> None:
        long_digest = sha("long") + "a"
        assert sha_from_key(f"l/{long_digest[:2]}/{long_digest}.jpg") is None

    def test_rejects_a_non_hex_digest(self) -> None:
        bogus = "z" * 64
        assert sha_from_key(f"l/{bogus[:2]}/{bogus}.jpg") is None

    def test_rejects_an_uppercase_hex_digest(self) -> None:
        """hexdigest() never produces uppercase, so this is by construction not ours."""
        digest = sha("uppercase").upper()
        assert sha_from_key(f"l/{digest[:2]}/{digest}.jpg") is None

    def test_rejects_wrong_segment_count(self) -> None:
        digest = sha("nested")
        assert sha_from_key(f"l/{digest[:2]}/extra/{digest}.jpg") is None
        assert sha_from_key(f"l/{digest}.jpg") is None

    def test_rejects_an_unmapped_prefix(self) -> None:
        digest = sha("unmapped")
        assert sha_from_key(f"xl/{digest[:2]}/{digest}.jpg") is None


class TestPlanBlobSweep:
    def test_a_referenced_shas_full_group_is_left_alone(self) -> None:
        digest = sha("referenced")
        keys = keys_for(digest)
        ages = {key: NOW - timedelta(days=1) for key in keys.values()}

        sweep = plan_blob_sweep({digest}, ages, now=NOW)

        assert sweep.orphaned_keys == frozenset()
        assert sweep.orphaned_shas == frozenset()

    def test_an_unreferenced_old_group_is_fully_orphaned(self) -> None:
        digest = sha("orphaned")
        keys = keys_for(digest)
        ages = {key: NOW - timedelta(days=1) for key in keys.values()}

        sweep = plan_blob_sweep(set(), ages, now=NOW)

        assert sweep.orphaned_keys == frozenset(keys.values())
        assert sweep.orphaned_shas == frozenset({digest})

    def test_a_too_recent_key_holds_back_the_whole_group(self) -> None:
        digest = sha("too-recent")
        keys = keys_for(digest)
        ages = {key: NOW - timedelta(days=1) for key in keys.values()}
        # One rendition uploaded moments ago — the group must not be orphaned this run.
        ages[keys["p"]] = NOW - timedelta(seconds=5)

        sweep = plan_blob_sweep(set(), ages, now=NOW, min_age=timedelta(minutes=60))

        assert sweep.orphaned_keys == frozenset()
        assert sweep.orphaned_shas == frozenset()
        assert sweep.recent_shas == frozenset({digest})

    def test_an_unknown_age_holds_back_the_whole_group(self) -> None:
        """`storage.objects.created_at` is Storage's own schema; a null age must be
        treated as unknown, never as old enough to delete."""
        digest = sha("unknown-age")
        keys = keys_for(digest)
        ages: dict[str, datetime | None] = {key: NOW - timedelta(days=1) for key in keys.values()}
        ages[keys["s"]] = None

        sweep = plan_blob_sweep(set(), ages, now=NOW)

        assert sweep.orphaned_keys == frozenset()
        assert sweep.recent_shas == frozenset({digest})

    def test_a_partial_group_is_still_orphaned(self) -> None:
        """Only 2 of 4 renditions present — a real gap, not something to silently ignore."""
        digest = sha("partial")
        keys = keys_for(digest)
        partial_ages = {
            keys["l"]: NOW - timedelta(days=1),
            keys["m"]: NOW - timedelta(days=1),
        }

        sweep = plan_blob_sweep(set(), partial_ages, now=NOW)

        assert sweep.orphaned_keys == frozenset(partial_ages)
        assert sweep.orphaned_shas == frozenset({digest})

    def test_an_unparseable_key_is_never_orphaned_even_with_an_empty_reference_set(
        self,
    ) -> None:
        ages: dict[str, datetime | None] = {"not/a/managed-key.jpg": NOW - timedelta(days=1)}

        sweep = plan_blob_sweep(set(), ages, now=NOW)

        assert sweep.orphaned_keys == frozenset()
        assert sweep.unexpected_keys == frozenset(ages)

    def test_classifications_are_pairwise_disjoint(self) -> None:
        old = sha("old-orphan")
        recent = sha("recent-orphan")
        referenced = sha("kept")
        ages: dict[str, datetime | None] = {
            **{key: NOW - timedelta(days=1) for key in keys_for(old).values()},
            **{key: NOW - timedelta(seconds=1) for key in keys_for(recent).values()},
            **{key: NOW - timedelta(days=1) for key in keys_for(referenced).values()},
            "garbage/key/here.jpg": NOW,
        }

        sweep = plan_blob_sweep({referenced}, ages, now=NOW)

        assert sweep.orphaned_keys.isdisjoint(sweep.unexpected_keys)
        assert not (sweep.recent_shas & sweep.orphaned_shas)
        recent_keys = {key for key in keys_for(recent).values()}
        assert sweep.orphaned_keys.isdisjoint(recent_keys)

    def test_referenced_sha_and_bucket_key_counts_are_reported(self) -> None:
        digest = sha("counted")
        ages = {key: NOW - timedelta(days=1) for key in keys_for(digest).values()}

        sweep = plan_blob_sweep({digest, sha("also-referenced")}, ages, now=NOW)

        assert sweep.referenced_sha_count == 2
        assert sweep.bucket_key_count == len(ages)


class TestRecheckOrphans:
    def test_drops_only_keys_whose_sha_became_referenced(self) -> None:
        stays_orphaned = sha("stays-orphaned")
        now_referenced = sha("now-referenced")
        orphaned = frozenset(
            {*keys_for(stays_orphaned).values(), *keys_for(now_referenced).values()}
        )

        kept = recheck_orphans(orphaned, {now_referenced})

        assert kept == frozenset(keys_for(stays_orphaned).values())


class TestExceedsSafetyThreshold:
    def test_true_over_the_fraction_on_a_large_bucket(self) -> None:
        assert exceeds_safety_threshold(11, 100) is True

    def test_false_under_the_fraction_on_a_large_bucket(self) -> None:
        assert exceeds_safety_threshold(5, 100) is False

    def test_false_under_min_bucket_size_regardless_of_fraction(self) -> None:
        assert exceeds_safety_threshold(orphaned_key_count=39, bucket_key_count=39) is False


class TestReferenceSetLooksWrong:
    def test_true_for_empty_reference_against_a_nonempty_bucket(self) -> None:
        assert reference_set_looks_wrong(0, 10) is True

    def test_false_when_both_are_empty(self) -> None:
        assert reference_set_looks_wrong(0, 0) is False

    def test_false_when_the_reference_set_is_nonempty(self) -> None:
        assert reference_set_looks_wrong(5, 10) is False

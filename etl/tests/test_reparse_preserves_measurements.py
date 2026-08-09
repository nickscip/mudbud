"""Regression coverage for E6: a text-only reparse must not null measured colour or media.

`AppearanceWriter.existing_pixel_data` only ever carried forward split composite regions
(rows with a `crop_bbox`, joined through `coat_levels`). An ordinary, single-swatch
appearance has neither, so `load --no-images` deleted-then-reinserted it with `hex`,
`hex2` and all six Lab columns null. `Loader.upsert_image`'s `ON CONFLICT` clause had the
identical bug shape for `glaze_images.storage_path` / `sha256` / `width` / `height`.

Runs `pipeline.ingest_product` end to end — a real `MaycoAdapter`, a real `Loader` bound to
a real disposable Postgres, and only `MediaProcessor` stubbed — because the bug is in how
two calls to the full pipeline interact with each other's state, not in one writer method
read in isolation.

Mayco fixtures are used because `MaycoAdapter.coat_order` is empty (F8b) and its filename
grammar never emits `ImageRole.COATS_COMPOSITE`, so every image in these two fixtures takes
the ordinary, non-composite path E6 describes.

Skipped unless a scratch Postgres is reachable — see test_store_integration.py for how to
provide one.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Iterator
from typing import cast

import psycopg
import pytest

from glaze_etl.core.color import ColorReading, Lab
from glaze_etl.core.loader import Loader
from glaze_etl.core.media import MediaProcessor, StoredImage
from glaze_etl.core.models import ManufacturerKey, RawSnapshot
from glaze_etl.core.normalizer import Normalizer, load_vocabularies
from glaze_etl.core.pipeline import ingest_product
from glaze_etl.sources.mayco.adapter import MaycoAdapter
from tests.conftest import snapshot_for

DSN = os.environ.get("TEST_SUPABASE_DB_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_SUPABASE_DB_URL not set")

type Connection = psycopg.Connection[tuple[object, ...]]


@pytest.fixture
def conn() -> Iterator[Connection]:
    assert DSN
    with psycopg.connect(DSN) as connection:
        yield connection
        connection.rollback()


def _stored_image(seed: str, generation_number: int) -> StoredImage:
    """A deterministic, fully-measured reading: dominant *and* secondary colour, so every
    one of the eight appearance colour columns this bug affects gets populated."""
    digest = hashlib.sha256(seed.encode()).hexdigest()
    return StoredImage(
        sha256=digest,
        width=100 + generation_number,
        height=200 + generation_number,
        storage_key=f"l/{digest[:2]}/{digest}.jpg",
        color=ColorReading(
            dominant=Lab(
                l=float(int(digest[0:2], 16)),
                a=float(int(digest[2:4], 16)) - 128.0,
                b=float(int(digest[4:6], 16)) - 128.0,
            ),
            secondary=Lab(
                l=float(int(digest[6:8], 16)),
                a=float(int(digest[8:10], 16)) - 128.0,
                b=float(int(digest[10:12], 16)) - 128.0,
            ),
            dominant_hex=f"#{digest[0:6]}",
            secondary_hex=f"#{digest[6:12]}",
            pixels_sampled=100,
        ),
    )


def _media_values(
    adapter: MaycoAdapter, snapshot: RawSnapshot, generation: str
) -> dict[str, StoredImage]:
    """One configured reading per image in the snapshot, keyed by source URL — what
    `StubMedia.process` looks each one up in."""
    generation_number = int(generation.removeprefix("v"))
    return {
        str(image.source_url): _stored_image(
            f"{generation}:{image.raw_filename}", generation_number
        )
        for image in adapter.parse(snapshot).images
    }


class StubMedia:
    """Answers with whatever reading the test configured for that URL. Never measures
    anything itself, so a v1/v2/v3 generation is entirely the test's own choice."""

    def __init__(self, values: dict[str, StoredImage]) -> None:
        self._values = values

    async def process(
        self,
        source_url: str,
        *,
        split_composite: bool = False,
        known_sha256: str | None = None,
    ) -> StoredImage:
        return self._values[source_url]


class FailingMedia:
    """The `media.process` exception branch `pipeline.py` actually catches (`OSError`),
    not a missing `media` argument. P002's coalesce fix has to cover this path too."""

    async def process(
        self,
        source_url: str,
        *,
        split_composite: bool = False,
        known_sha256: str | None = None,
    ) -> StoredImage:
        raise OSError("simulated failure")


def _loader(conn: Connection) -> Loader:
    vocabularies = load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)
    return Loader(conn, Normalizer(vocabularies))


def _glaze_id(conn: Connection, code: str) -> int:
    row = conn.execute(
        "select g.id from glazes g join manufacturers m on m.id = g.manufacturer_id"
        " where m.key = 'mayco' and g.code = %s",
        (code,),
    ).fetchone()
    assert row is not None and isinstance(row[0], int)
    return row[0]


def _rows(conn: Connection, glaze_id: int) -> list[tuple[object, ...]]:
    """Every image of one glaze, left-joined to its appearance's measured colour, ordered
    so a before/after comparison is stable rather than depending on insert order."""
    return conn.execute(
        """
        select gi.source_url, gi.storage_path, gi.sha256, gi.width, gi.height,
               a.hex, a.hex2, a.lab_l, a.lab_a, a.lab_b, a.lab2_l, a.lab2_a, a.lab2_b
        from glaze_images gi
        left join appearances a on a.image_id = gi.id
        where gi.glaze_id = %s
        order by gi.source_url
        """,
        (glaze_id,),
    ).fetchall()


async def test_a_text_only_reparse_preserves_measured_colour_and_media(
    conn: Connection,
) -> None:
    """The core E6 regression, for an ordinary non-composite appearance."""
    adapter = MaycoAdapter()
    loader = _loader(conn)
    snapshot = snapshot_for("sc-104-grape-expectations", source="mayco")

    media_v1 = cast(MediaProcessor, StubMedia(_media_values(adapter, snapshot, "v1")))
    await ingest_product(snapshot, adapter, loader, media_v1, None)
    glaze_id = _glaze_id(conn, "SC-104")
    rows_v1 = _rows(conn, glaze_id)
    assert len(rows_v1) == 3, f"expected 3 images for sc-104-grape-expectations, got {rows_v1}"
    for row in rows_v1:
        assert all(value is not None for value in row[1:]), f"expected a full row, got {row}"

    media_v2 = cast(MediaProcessor, StubMedia(_media_values(adapter, snapshot, "v2")))
    await ingest_product(snapshot, adapter, loader, media_v2, None)
    rows_v2 = _rows(conn, glaze_id)
    # Every measured column, not just some of them, must have moved — a coalesce pointed
    # the wrong way (P002's own risk) would leave stale columns behind a `!=` on the row
    # as a whole would miss.
    assert all(
        new != old
        for row_new, row_old in zip(rows_v2, rows_v1, strict=True)
        for new, old in zip(row_new[1:], row_old[1:], strict=True)
    ), "fresh pixel data should legitimately overwrite every old measured column"

    await ingest_product(snapshot, adapter, loader, None, None)
    rows_v3 = _rows(conn, glaze_id)
    assert rows_v3 == rows_v2, (
        "a text-only reparse (media=None) must carry the last measured colour and media "
        "forward rather than nulling them (E6)"
    )


async def test_a_never_processed_image_stays_null_after_a_bare_ingest(
    conn: Connection,
) -> None:
    """Guards the new carry-forward paths against inventing data where none existed.

    Uses `lilac`, which shares no fixture with the test above, so this is a cold start.
    """
    adapter = MaycoAdapter()
    loader = _loader(conn)
    snapshot = snapshot_for("lilac", source="mayco")

    await ingest_product(snapshot, adapter, loader, None, None)

    glaze_id = _glaze_id(conn, "EZ-112")
    rows = _rows(conn, glaze_id)
    assert len(rows) == 3, f"expected 3 images for lilac, got {rows}"
    for row in rows:
        assert all(value is None for value in row[1:]), f"expected an all-null row, got {row}"


async def test_a_media_processing_failure_preserves_prior_measurements(
    conn: Connection,
) -> None:
    """R002: P002's coalesce fix also covers `media.process` raising, not only `media=None`
    — the gap the original plan left uncovered."""
    adapter = MaycoAdapter()
    loader = _loader(conn)
    snapshot = snapshot_for("sc-104-grape-expectations", source="mayco")

    media_v1 = cast(MediaProcessor, StubMedia(_media_values(adapter, snapshot, "v1")))
    await ingest_product(snapshot, adapter, loader, media_v1, None)
    glaze_id = _glaze_id(conn, "SC-104")
    rows_v1 = _rows(conn, glaze_id)

    await ingest_product(snapshot, adapter, loader, cast(MediaProcessor, FailingMedia()), None)
    rows_v2 = _rows(conn, glaze_id)
    assert rows_v2 == rows_v1, (
        "an image that failed to process this run must keep what a prior run measured"
    )

    manufacturer_row = conn.execute(
        "select id from manufacturers where key = 'mayco'"
    ).fetchone()
    assert manufacturer_row is not None
    issues = conn.execute(
        "select count(*) from parse_issues"
        " where kind = 'image_unreadable' and manufacturer_id = %s and resolved_at is null",
        (manufacturer_row[0],),
    ).fetchone()
    # Exactly 3: record_issue dedupes only by (kind, subject) while unresolved, and this
    # fixture's three filenames (SC-104.jpg, SC-104_cone6.jpg, sc104_cone10.jpg) are
    # pairwise distinct subjects, so nothing collapses the count. Swap the fixture and this
    # assertion's expected count has to move with it.
    assert issues is not None and issues[0] == 3

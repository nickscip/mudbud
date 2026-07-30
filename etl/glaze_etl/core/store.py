"""Persistence for the crawl log — every `raw_snapshots` query lives here.

Two audiences, deliberately different shapes. The Fetcher needs exactly three things
from storage: what it saw for a URL last time, somewhere to put a new snapshot, and a
way to prune. That is the `SnapshotStore` Protocol, kept narrow so the Fetcher stays
testable against an in-memory double.

The read-back side — replaying stored pages through the parser — is needed only by the
CLI and the Temporal activities, both of which hold a real connection. Those methods
live on `PostgresSnapshotStore` alone rather than on the Protocol, so the Fetcher does
not acquire a dependency on queries it never issues. They are here, and not inlined
into their callers, because three hand-written copies of "newest snapshot per URL" had
already drifted apart on whether to scope by manufacturer.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

import psycopg
from psycopg.rows import class_row

from glaze_etl.core.models import ManufacturerKey, RawSnapshot


@dataclass(frozen=True)
class SnapshotHead:
    """What we already hold for a URL, used to build a conditional request."""

    etag: str | None
    content_hash: str
    fetched_at: datetime


class SnapshotStore(Protocol):
    def head(self, url: str) -> SnapshotHead | None: ...

    def insert(self, manufacturer: ManufacturerKey, snap: RawSnapshot) -> int: ...

    def prune(self, url: str, keep: int) -> int: ...


class InMemorySnapshotStore:
    """Test double. Mirrors the SQL implementation's semantics exactly."""

    def __init__(self) -> None:
        self.rows: list[tuple[ManufacturerKey, RawSnapshot]] = []

    def head(self, url: str) -> SnapshotHead | None:
        matching = [s for _, s in self.rows if str(s.url) == url]
        if not matching:
            return None
        newest = max(matching, key=lambda s: s.fetched_at)
        return SnapshotHead(newest.etag, newest.content_hash, newest.fetched_at)

    def insert(self, manufacturer: ManufacturerKey, snap: RawSnapshot) -> int:
        self.rows.append((manufacturer, snap))
        return len(self.rows)

    def prune(self, url: str, keep: int) -> int:
        matching = sorted(
            (r for r in self.rows if str(r[1].url) == url),
            key=lambda r: r[1].fetched_at,
            reverse=True,
        )
        doomed = matching[keep:]
        for row in doomed:
            self.rows.remove(row)
        return len(doomed)


class PostgresSnapshotStore:
    def __init__(self, conn: psycopg.Connection[tuple[object, ...]]) -> None:
        self._conn = conn

    def head(self, url: str) -> SnapshotHead | None:
        with self._conn.cursor(row_factory=class_row(SnapshotHead)) as cur:
            cur.execute(
                """
                select etag, content_hash, fetched_at
                from raw_snapshots
                where url = %s
                order by fetched_at desc
                limit 1
                """,
                (url,),
            )
            return cur.fetchone()

    def insert(self, manufacturer: ManufacturerKey, snap: RawSnapshot) -> int:
        with self._conn.cursor() as cur:
            cur.execute(
                """
                insert into raw_snapshots
                  (manufacturer_id, url, fetched_at, http_status, etag, content_hash, body)
                select m.id, %s, %s, %s, %s, %s, %s
                from manufacturers m where m.key = %s
                returning id
                """,
                (
                    str(snap.url),
                    snap.fetched_at,
                    snap.http_status,
                    snap.etag,
                    snap.content_hash,
                    snap.body,
                    manufacturer.value,
                ),
            )
            row = cur.fetchone()
            if row is None:
                raise LookupError(f"unknown manufacturer {manufacturer.value!r}")
            snapshot_id = row[0]
            assert isinstance(snapshot_id, int)
            return snapshot_id

    def prune(self, url: str, keep: int) -> int:
        with self._conn.cursor() as cur:
            cur.execute(
                """
                delete from raw_snapshots
                where id in (
                  select id from raw_snapshots
                  where url = %s
                  order by fetched_at desc
                  offset %s
                )
                """,
                (url, keep),
            )
            return cur.rowcount

    def newest(self, url: str, manufacturer: ManufacturerKey) -> RawSnapshot | None:
        """The current snapshot for one URL, or None if this source has never stored it.

        Scoped by manufacturer because the caller has already chosen a parser from the
        same key: an unscoped lookup would hand one source's HTML to another's parser
        whenever the pair disagrees.
        """
        with self._conn.cursor(row_factory=class_row(RawSnapshot)) as cur:
            cur.execute(
                """
                select s.url, s.fetched_at, s.http_status, s.etag, s.content_hash, s.body
                from raw_snapshots s
                join manufacturers m on m.id = s.manufacturer_id
                where s.url = %s and m.key = %s
                order by s.fetched_at desc
                limit 1
                """,
                (url, manufacturer.value),
            )
            return cur.fetchone()

    def newest_per_url(
        self, manufacturer: ManufacturerKey, urls: Sequence[str] | None = None
    ) -> list[RawSnapshot]:
        """This source's current snapshot for every URL it holds, newest per URL.

        Older rows are history, not current truth. ``urls`` narrows to a specific set —
        they must byte-match what the Fetcher stored, so callers build them through the
        adapter's `product_ref` rather than by string-formatting a host.
        """
        with self._conn.cursor(row_factory=class_row(RawSnapshot)) as cur:
            cur.execute(
                """
                select distinct on (s.url)
                       s.url, s.fetched_at, s.http_status, s.etag, s.content_hash, s.body
                from raw_snapshots s
                join manufacturers m on m.id = s.manufacturer_id
                where m.key = %(manufacturer)s
                  and (%(urls)s::text[] is null or s.url = any(%(urls)s::text[]))
                order by s.url, s.fetched_at desc
                """,
                {
                    "manufacturer": manufacturer.value,
                    "urls": list(urls) if urls is not None else None,
                },
            )
            return cur.fetchall()

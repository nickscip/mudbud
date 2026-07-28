"""Persistence for the crawl log, expressed as a narrow protocol.

The Fetcher needs exactly three things from storage: what it saw for a URL last time,
somewhere to put a new snapshot, and a way to prune. Defining that as a Protocol keeps
the Fetcher testable without a database and keeps the SQL in one place.
"""

from __future__ import annotations

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

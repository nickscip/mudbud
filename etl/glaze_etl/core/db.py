"""The one place a Postgres connection is opened.

Exists because of a specific incompatibility. Supabase's pooled connection string (pgbouncer,
port 6543) runs in *transaction* pooling mode, where a client may get a different backend
between statements. psycopg3 issues prepared statements automatically once it sees the same
query a few times, and those live on one backend, so the second use lands somewhere that has
never heard of them:

    DuplicatePreparedStatement: prepared statement "_pg3_0" already exists

Passing ``prepare_threshold=None`` turns that off. The pooled URI is still the right one for
this workload — the crawl opens and closes a connection per product, which is exactly what a
pooler is for — so the fix is to stop preparing, not to fall back to the direct port.

Centralised so no call site can forget, which is how the bug reached a live run.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime

import psycopg

Connection = psycopg.Connection[tuple[object, ...]]


class BlobOperationAlreadyRunning(RuntimeError):
    """A sync/load/GC prune already owns a manufacturer's mutation lock."""


def _blob_operation_lock_id(manufacturer: str) -> int:
    """Stable signed bigint for Postgres's one-argument advisory-lock namespace."""
    digest = hashlib.sha256(f"mudbud:blob-operation:{manufacturer}".encode()).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


def connect(database_url: str, *, autocommit: bool = False) -> Connection:
    """Open a connection that is safe against a transaction-mode pooler."""
    return psycopg.connect(
        database_url,
        autocommit=autocommit,
        # See module docstring: mandatory for pgbouncer transaction pooling.
        prepare_threshold=None,
    )


@contextmanager
def connection(database_url: str, *, autocommit: bool = False) -> Iterator[Connection]:
    conn = connect(database_url, autocommit=autocommit)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def exclusive_blob_operation(database_url: str, manufacturer: str) -> Iterator[None]:
    """Exclude concurrent blob writers and pruners for one manufacturer.

    The lock lives in a dedicated, deliberately open transaction. That detail makes a
    transaction-level advisory lock work through Supabase's transaction-mode pooler: the
    pooler pins this connection to one backend until the transaction ends. A session lock
    would leak onto an arbitrary pooled backend as soon as a statement completed.
    """
    lock_conn = connect(database_url)
    try:
        row = lock_conn.execute(
            "select pg_try_advisory_xact_lock(%s)",
            (_blob_operation_lock_id(manufacturer),),
        ).fetchone()
        if row is None or row[0] is not True:
            raise BlobOperationAlreadyRunning(manufacturer)
        yield
    finally:
        lock_conn.rollback()
        lock_conn.close()


def stored_object_keys(conn: Connection, bucket: str) -> set[str]:
    """Every object key already in a Storage bucket, in one query.

    Storage metadata lives in `storage.objects`, which the service role can read directly. That
    turns "is this blob already uploaded?" from one HTTP round trip per blob — 1294 of them on
    a full load, about 12 minutes of latency — into a single statement.

    Returns an empty set if the schema is absent, which is the case for a plain Postgres with
    no Supabase Storage installed.
    """
    try:
        rows = conn.execute(
            """
            select o.name from storage.objects o
            join storage.buckets b on b.id = o.bucket_id
            where b.name = %s
            """,
            (bucket,),
        ).fetchall()
    except psycopg.Error:
        conn.rollback()
        return set()
    return {str(r[0]) for r in rows}


def referenced_shas(conn: Connection, manufacturer: str) -> set[str]:
    """Every sha256 a manufacturer's `glaze_images` rows still cite.

    Joins `glaze_images -> glazes -> manufacturers` on `manufacturers.key` — the same path
    the app and loader already use. Getting this join backwards is how a sweep for one
    brand could treat another brand's photographs as unreferenced, so it is worth stating
    plainly: filter by `m.key`, never by anything storage-shaped.
    """
    rows = conn.execute(
        """
        select distinct gi.sha256
        from glaze_images gi
        join glazes g on g.id = gi.glaze_id
        join manufacturers m on m.id = g.manufacturer_id
        where m.key = %s and gi.sha256 is not null
        """,
        (manufacturer,),
    ).fetchall()
    return {str(r[0]) for r in rows}


def stored_object_ages(conn: Connection, bucket: str) -> dict[str, datetime | None]:
    """Every object key in a Storage bucket, mapped to when it was created.

    `storage.objects.created_at` is provisioned by the Storage service, not by this
    repo's own migrations, so its nullability is not something this codebase controls —
    callers must treat a `None` age as "unknown", never as "old enough to delete". Unlike
    the upload-path optimization in `stored_object_keys`, this destructive-operation input
    propagates query failures. An unreadable or absent Storage schema is not evidence that
    a bucket is empty.
    """
    rows = conn.execute(
        """
        select o.name, o.created_at from storage.objects o
        join storage.buckets b on b.id = o.bucket_id
        where b.name = %s
        """,
        (bucket,),
    ).fetchall()
    return {
        str(row[0]): row[1] if isinstance(row[1], datetime) else None
        for row in rows
    }

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

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime

import psycopg

Connection = psycopg.Connection[tuple[object, ...]]


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
    callers must treat a `None` age as "unknown", never as "old enough to delete". Wrapped
    in the same fail-closed try/except as `stored_object_keys`: a bare Postgres with no
    Supabase Storage schema installed degrades to an empty dict — a safe no-op sweep —
    rather than raising.
    """
    try:
        rows = conn.execute(
            """
            select o.name, o.created_at from storage.objects o
            join storage.buckets b on b.id = o.bucket_id
            where b.name = %s
            """,
            (bucket,),
        ).fetchall()
    except psycopg.Error:
        conn.rollback()
        return {}
    return {
        str(row[0]): row[1] if isinstance(row[1], datetime) else None
        for row in rows
    }

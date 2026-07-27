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

"""Proves appearance parse issues are filed against the product's manufacturer.

The writer used to hardcode "amaco" (roadmap F2), so a second source's unresolved
filename tokens would have landed in AMACO's triage queue. Needs a real database
because the issue row's manufacturer_id is resolved by key in SQL.

Skipped unless a scratch Postgres is reachable — see test_store_integration.py for
how to provide one.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest

from glaze_etl.core.loader import Loader
from glaze_etl.core.models import Confidence, ImageFacts, ImageRole
from glaze_etl.core.normalizer import Normalizer, load_vocabularies
from glaze_etl.core.payloads import ImagePayload

DSN = os.environ.get("TEST_SUPABASE_DB_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_SUPABASE_DB_URL not set")

type Connection = psycopg.Connection[tuple[object, ...]]


@pytest.fixture
def conn() -> Iterator[Connection]:
    assert DSN
    with psycopg.connect(DSN) as connection:
        yield connection
        connection.rollback()


def _inserted_id(conn: Connection, sql: str, params: tuple[object, ...] = ()) -> int:
    row = conn.execute(sql, params).fetchone()
    assert row is not None and isinstance(row[0], int)
    return row[0]


def test_issue_lands_under_the_manufacturer_passed_in(conn: Connection) -> None:
    testco_id = _inserted_id(
        conn,
        "insert into manufacturers (key, name, site_url)"
        " values ('testco', 'Test Co', 'https://example.test') returning id",
    )
    glaze_id = _inserted_id(
        conn,
        "insert into glazes (manufacturer_id, code, name, slug, product_url)"
        " values (%s, 'TC-1', 'Test Glaze', 'tc-1', 'https://example.test/tc-1/')"
        " returning id",
        (testco_id,),
    )
    image_id = _inserted_id(
        conn,
        "insert into glaze_images (glaze_id, source_url, role, raw_filename,"
        " parse_confidence)"
        " values (%s, 'https://example.test/tc-1.jpg', 'in_use', 'TC-1_Cone99.jpg',"
        " 'high') returning id",
        (glaze_id,),
    )

    loader = Loader(conn, Normalizer(load_vocabularies(conn)))
    payload = ImagePayload(
        # Cone 99 does not exist, so resolve_appearance files unknown_cone — the
        # issue path this test pins to the right manufacturer.
        facts=ImageFacts(role=ImageRole.IN_USE, cone="99", confidence=Confidence.HIGH),
        source_url="https://example.test/tc-1.jpg",
        raw_filename="TC-1_Cone99.jpg",
    )
    loader.replace_appearances(glaze_id, image_id, payload, manufacturer="testco")

    row = conn.execute(
        "select m.key from parse_issues i join manufacturers m on m.id = i.manufacturer_id"
        " where i.kind = 'unknown_cone' and i.subject = 'TC-1_Cone99.jpg'"
    ).fetchone()
    assert row is not None and row[0] == "testco"

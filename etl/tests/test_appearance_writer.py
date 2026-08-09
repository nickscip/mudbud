"""Proves appearance parse issues are filed against the product's manufacturer.

The writer used to hardcode "amaco" (roadmap F2), so a second source's unresolved
filename tokens would have landed in AMACO's triage queue. Needs a real database
because the issue row's manufacturer_id is resolved by key in SQL.

The product here is Mayco rather than the invented `testco` this started as. F8 scoped
the vocabulary to one manufacturer and the writer now refuses a product that is not the
one its normalizer resolves — so the two brands in the test have to be brands the loader
can actually build a vocabulary for, and `ManufacturerKey` has exactly two members.

Skipped unless a scratch Postgres is reachable — see test_store_integration.py for
how to provide one.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest

from glaze_etl.core.loader import Loader
from glaze_etl.core.models import Confidence, ImageFacts, ImageRole, ManufacturerKey
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
    mayco_id = _inserted_id(
        conn, "select id from manufacturers where key = 'mayco'"
    )
    glaze_id = _inserted_id(
        conn,
        "insert into glazes (manufacturer_id, code, name, slug, product_url)"
        " values (%s, 'TC-1', 'Test Glaze', 'tc-1', 'https://example.test/tc-1/')"
        " returning id",
        (mayco_id,),
    )
    image_id = _inserted_id(
        conn,
        "insert into glaze_images (glaze_id, source_url, role, raw_filename,"
        " parse_confidence)"
        " values (%s, 'https://example.test/tc-1.jpg', 'in_use', 'TC-1_Cone99.jpg',"
        " 'high') returning id",
        (glaze_id,),
    )

    vocabularies = load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)
    loader = Loader(conn, Normalizer(vocabularies))
    payload = ImagePayload(
        # Cone 99 does not exist, so resolve_appearance files unknown_cone — the
        # issue path this test pins to the right manufacturer.
        facts=ImageFacts(role=ImageRole.IN_USE, cone="99", confidence=Confidence.HIGH),
        source_url="https://example.test/tc-1.jpg",
        raw_filename="TC-1_Cone99.jpg",
    )
    loader.replace_appearances(glaze_id, image_id, payload, manufacturer="mayco")

    row = conn.execute(
        "select m.key from parse_issues i join manufacturers m on m.id = i.manufacturer_id"
        " where i.kind = 'unknown_cone' and i.subject = 'TC-1_Cone99.jpg'"
    ).fetchone()
    assert row is not None and row[0] == "mayco"


def test_a_product_the_normalizer_does_not_resolve_is_refused(conn: Connection) -> None:
    """The other half of F2's lesson, which F8 made checkable.

    Passing the manufacturer per call is what stopped issues landing under a hardcoded
    brand; it also means nothing tied that argument to the vocabulary being resolved
    against. Now the vocabulary is one brand's, so a mismatched pair would try to write
    AMACO's coat and clay ids onto a Mayco product.

    The database refuses that too — `appearances_manufacturer_scope` raises 23514 — so this
    is not the only thing standing between the pair and a bad row. It is the one that names
    the actual mistake: the trigger reports a manufacturer mismatch on one appearance, while
    the cause is a loader built with the wrong source's vocabulary, every row of which is
    wrong.
    """
    mayco_id = _inserted_id(conn, "select id from manufacturers where key = 'mayco'")
    glaze_id = _inserted_id(
        conn,
        "insert into glazes (manufacturer_id, code, name, slug, product_url)"
        " values (%s, 'TC-2', 'Test Glaze', 'tc-2', 'https://example.test/tc-2/')"
        " returning id",
        (mayco_id,),
    )
    image_id = _inserted_id(
        conn,
        "insert into glaze_images (glaze_id, source_url, role, raw_filename,"
        " parse_confidence)"
        " values (%s, 'https://example.test/tc-2.jpg', 'in_use', 'TC-2.jpg',"
        " 'high') returning id",
        (glaze_id,),
    )

    loader = Loader(conn, Normalizer(load_vocabularies(conn, manufacturer=ManufacturerKey.AMACO)))
    payload = ImagePayload(
        facts=ImageFacts(role=ImageRole.IN_USE, confidence=Confidence.HIGH),
        source_url="https://example.test/tc-2.jpg",
        raw_filename="TC-2.jpg",
    )

    with pytest.raises(ValueError, match="amaco"):
        loader.replace_appearances(glaze_id, image_id, payload, manufacturer="mayco")


def test_more_than_one_whole_image_appearance_row_fails_loudly_instead_of_choosing_one(
    conn: Connection,
) -> None:
    """R003: nothing at the schema level stops two `crop_bbox is null` rows sharing one
    `image_id`, even though no current write path produces that state. Inserted directly
    by SQL here, bypassing `AppearanceWriter` entirely, since it never produces this state
    itself. A text-only reparse that finds it must refuse to guess which one is right
    rather than silently keeping one and discarding the other.
    """
    mayco_id = _inserted_id(conn, "select id from manufacturers where key = 'mayco'")
    glaze_id = _inserted_id(
        conn,
        "insert into glazes (manufacturer_id, code, name, slug, product_url)"
        " values (%s, 'TC-3', 'Test Glaze', 'tc-3', 'https://example.test/tc-3/')"
        " returning id",
        (mayco_id,),
    )
    image_id = _inserted_id(
        conn,
        "insert into glaze_images (glaze_id, source_url, role, raw_filename,"
        " parse_confidence)"
        " values (%s, 'https://example.test/tc-3.jpg', 'label_chip', 'TC-3.jpg',"
        " 'high') returning id",
        (glaze_id,),
    )
    for hex_value in ("#111111", "#222222"):
        conn.execute(
            "insert into appearances (glaze_id, image_id, hex, source, confidence)"
            " values (%s, %s, %s, 'manufacturer', 'high')",
            (glaze_id, image_id, hex_value),
        )

    loader = Loader(conn, Normalizer(load_vocabularies(conn, manufacturer=ManufacturerKey.MAYCO)))
    payload = ImagePayload(
        facts=ImageFacts(role=ImageRole.LABEL_CHIP, confidence=Confidence.HIGH),
        source_url="https://example.test/tc-3.jpg",
        raw_filename="TC-3.jpg",
    )

    with pytest.raises(ValueError, match=f"image {image_id} has more than one"):
        loader.replace_appearances(glaze_id, image_id, payload, manufacturer="mayco")

    row = conn.execute(
        "select count(*) from appearances where image_id = %s", (image_id,)
    ).fetchone()
    assert row is not None and row[0] == 2, "the raise must happen before the delete"

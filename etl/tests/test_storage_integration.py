"""SupabaseBlobStore against a real Storage service.

Skipped unless credentials are present. To run against the local stack:

    supabase start
    TEST_SUPABASE_URL=http://127.0.0.1:54321 \
    TEST_SUPABASE_SERVICE_KEY=<service_role key from `supabase status`> \
    uv run pytest tests/test_storage_integration.py

The privacy assertion is the important one: these are AMACO's photographs, and caching them
is only defensible because the bucket is not publicly readable.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import httpx
import pytest

from glaze_etl.core.media import SupabaseBlobStore, storage_key

URL = os.environ.get("TEST_SUPABASE_URL")
KEY = os.environ.get("TEST_SUPABASE_SERVICE_KEY")
pytestmark = pytest.mark.skipif(
    not (URL and KEY), reason="TEST_SUPABASE_URL / _SERVICE_KEY not set"
)

PAYLOAD = b"\xff\xd8\xff\xe0" + b"fake jpeg bytes" * 8


@pytest.fixture
def store() -> Iterator[SupabaseBlobStore]:
    assert URL and KEY
    with SupabaseBlobStore(URL, KEY, "glaze-images-test") as blobs:
        yield blobs


@pytest.fixture
def key() -> str:
    return storage_key(uuid.uuid4().hex * 2, "l")


class TestRoundTrip:
    def test_absent_key_reports_false(self, store: SupabaseBlobStore, key: str) -> None:
        assert store.exists(key) is False

    def test_upload_then_exists(self, store: SupabaseBlobStore, key: str) -> None:
        store.put(key, PAYLOAD, "image/jpeg")
        assert store.exists(key) is True

    def test_upload_is_idempotent(self, store: SupabaseBlobStore, key: str) -> None:
        """The pipeline re-runs weekly; a repeated put must not error."""
        store.put(key, PAYLOAD, "image/jpeg")
        store.put(key, PAYLOAD, "image/jpeg")
        assert store.exists(key) is True


class TestPrivacy:
    def test_signed_url_reads(self, store: SupabaseBlobStore, key: str) -> None:
        store.put(key, PAYLOAD, "image/jpeg")
        response = httpx.get(store.signed_url(key, 120))
        assert response.status_code == 200
        assert response.content == PAYLOAD

    def test_bucket_is_not_publicly_readable(
        self, store: SupabaseBlobStore, key: str
    ) -> None:
        """Caching manufacturer photography is only defensible while this holds."""
        store.put(key, PAYLOAD, "image/jpeg")
        assert URL
        response = httpx.get(f"{URL}/storage/v1/object/public/glaze-images-test/{key}")
        assert response.status_code != 200, "bucket is public; that is a rehost"

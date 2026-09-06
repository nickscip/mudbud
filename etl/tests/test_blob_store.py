"""The blob stores and the rule that picks between them, with storage3 swapped out.

The real `storage3.SyncStorageClient` is never constructed here. Its own `timeout`
parameter is deprecated in 2.31, and `filterwarnings = ["error"]` turns that
DeprecationWarning into a test failure — which is the same reason the production code
puts the timeout on an httpx client it owns. `SupabaseBlobStore.__init__` imports the
name lazily, so patching the module attribute replaces the whole client.

`tests/test_storage_integration.py` runs the same store against a real Storage service
and is skipped without credentials; this file is what covers the wiring on every run.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from glaze_etl.core.blob_store import LocalBlobStore, SupabaseBlobStore, blob_store_for
from glaze_etl.core.config import Settings

URL = "http://storage.example"
KEY = "sb_secret_example"
BUCKET = "mudbud_amaco"


class FakeBucket:
    """storage3's bucket proxy minus the HTTP.

    `exists` raises for a key that is not there rather than returning False, which is what
    the real client does and what `SupabaseBlobStore.exists` exists to swallow. `false_keys`
    covers the other answer — a client that reports absence politely.
    """

    def __init__(self) -> None:
        self.objects: set[str] = set()
        self.false_keys: set[str] = set()
        self.exists_calls: list[str] = []
        self.uploads: list[tuple[str, bytes, dict[str, str]]] = []
        self.removed: list[list[str]] = []

    def exists(self, key: str) -> bool:
        self.exists_calls.append(key)
        if key in self.objects:
            return True
        if key in self.false_keys:
            return False
        raise FileNotFoundError(key)

    def upload(self, key: str, data: bytes, file_options: dict[str, str]) -> None:
        self.uploads.append((key, data, file_options))
        self.objects.add(key)

    def remove(self, keys: list[str]) -> None:
        self.removed.append(list(keys))
        self.objects.difference_update(keys)

    def create_signed_url(self, key: str, expires_in: int) -> dict[str, str]:
        return {"signedURL": f"{URL}/object/sign/{key}?exp={expires_in}"}


class FakeStorageClient:
    def __init__(
        self,
        url: str,
        headers: dict[str, str],
        http_client: Any = None,
        *,
        existing: list[str] | None = None,
    ) -> None:
        self.url = url
        self.headers = headers
        self.http_client = http_client
        self.buckets = [SimpleNamespace(id=name) for name in existing or []]
        self.created: list[tuple[str, dict[str, bool]]] = []
        self.bucket = FakeBucket()

    def list_buckets(self) -> list[SimpleNamespace]:
        return self.buckets

    def create_bucket(self, id: str, options: dict[str, bool]) -> None:
        self.created.append((id, options))
        self.buckets.append(SimpleNamespace(id=id))

    def from_(self, id: str) -> FakeBucket:
        return self.bucket


@pytest.fixture
def existing_buckets(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Installs the fake storage client. The returned list is what it reports as existing,
    so a test that wants a bucket already there appends to it before building a store."""
    existing: list[str] = []
    monkeypatch.setattr(
        "storage3.SyncStorageClient",
        lambda url, headers, http_client=None: FakeStorageClient(
            url, headers, http_client, existing=existing
        ),
    )
    return existing


@pytest.fixture
def make_store(existing_buckets: list[str]) -> Iterator[Any]:
    stores: list[SupabaseBlobStore] = []

    def build(
        *,
        url: str = URL,
        bucket: str = BUCKET,
        known_keys: set[str] | None = None,
        objects: Iterable[str] = (),
        false_keys: Iterable[str] = (),
    ) -> SupabaseBlobStore:
        store = SupabaseBlobStore(url, KEY, bucket, known_keys=known_keys)
        store._storage.bucket.objects.update(objects)
        store._storage.bucket.false_keys.update(false_keys)
        stores.append(store)
        return store

    yield build
    for store in stores:
        store.close()


class TestBucketBootstrap:
    def test_an_absent_bucket_is_created_private(self, make_store: Any) -> None:
        """Public would make the cache a straightforward rehost of AMACO's photographs."""
        store = make_store()

        assert store._storage.created == [(BUCKET, {"public": False})]

    def test_an_existing_bucket_is_left_alone(
        self, existing_buckets: list[str], make_store: Any
    ) -> None:
        existing_buckets.extend(["mudbud_mayco", BUCKET])

        assert make_store()._storage.created == []


class TestClientWiring:
    @pytest.mark.parametrize("url", ["http://x", "http://x/"])
    def test_the_storage_path_gets_exactly_one_slash(self, make_store: Any, url: str) -> None:
        """storage3 warns and rewrites a URL missing the trailing slash, and a doubled one
        is a 404 — so the caller's own trailing slash must not survive."""
        assert make_store(url=url)._storage.url == "http://x/storage/v1/"

    def test_the_secret_rides_in_both_headers(self, make_store: Any) -> None:
        store = make_store()

        assert store._storage.headers == {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

    def test_the_http_client_is_the_one_we_close(self, make_store: Any) -> None:
        store = make_store()

        assert store._storage.http_client is store._http


class TestExists:
    def test_a_preloaded_key_never_reaches_the_bucket(self, make_store: Any) -> None:
        """The point of `known_keys`: 1294 blobs used to cost 1294 round trips."""
        store = make_store(known_keys={"a/b.webp"})

        assert store.exists("a/b.webp") is True
        assert store._storage.bucket.exists_calls == []

    def test_a_found_key_is_asked_for_once(self, make_store: Any) -> None:
        store = make_store(objects={"a/b.webp"})

        assert [store.exists("a/b.webp"), store.exists("a/b.webp")] == [True, True]
        assert store._storage.bucket.exists_calls == ["a/b.webp"]

    def test_a_polite_false_is_not_memoised(self, make_store: Any) -> None:
        store = make_store(false_keys={"gone.webp"})

        assert store.exists("gone.webp") is False
        assert store.exists("gone.webp") is False
        assert store._storage.bucket.exists_calls == ["gone.webp", "gone.webp"]

    def test_a_raising_bucket_reads_as_absent(self, make_store: Any) -> None:
        store = make_store()

        assert store.exists("never-uploaded.webp") is False


class TestPut:
    def test_upload_upserts_with_the_content_type(self, make_store: Any) -> None:
        store = make_store()

        assert store.put("a/b.webp", b"bytes", "image/webp") == "a/b.webp"
        assert store._storage.bucket.uploads == [
            (
                "a/b.webp",
                b"bytes",
                {
                    "content-type": "image/webp",
                    "upsert": "true",
                    "cache-control": "31536000",
                },
            )
        ]

    def test_an_uploaded_key_is_remembered(self, make_store: Any) -> None:
        store = make_store()
        store.put("a/b.webp", b"bytes", "image/webp")

        assert store.exists("a/b.webp") is True
        assert store._storage.bucket.exists_calls == []


class TestRemove:
    def test_removal_chunks_and_forgets_the_keys(self, make_store: Any) -> None:
        """Chunked defensively against a server-side cap storage3's own `remove` does not
        impose. Forgetting matters as much: a stale memo would report a deleted blob present."""
        keys = [f"a/{n}.webp" for n in range(205)]
        store = make_store(known_keys=set(keys))

        store.remove(keys)

        assert [len(chunk) for chunk in store._storage.bucket.removed] == [100, 100, 5]
        assert store.exists(keys[0]) is False
        assert store._storage.bucket.exists_calls == [keys[0]]


class TestSignedUrl:
    def test_the_response_is_unwrapped(self, make_store: Any) -> None:
        store = make_store(objects={"a/b.webp"})

        assert store.signed_url("a/b.webp") == f"{URL}/object/sign/a/b.webp?exp=3600"
        assert store.signed_url("a/b.webp", 120) == f"{URL}/object/sign/a/b.webp?exp=120"


class TestClose:
    def test_the_context_manager_closes_our_client(self, make_store: Any) -> None:
        store = make_store()

        with store as entered:
            assert entered is store
            assert not store._http.is_closed

        assert store._http.is_closed


class TestLocalBlobStore:
    def test_exists_answers_for_the_filesystem(self, tmp_path: Path) -> None:
        blobs = LocalBlobStore(tmp_path / "blobs")

        assert blobs.exists("a/b.webp") is False
        blobs.put("a/b.webp", b"bytes", "image/webp")
        assert blobs.exists("a/b.webp") is True

    def test_put_creates_the_directories_a_key_implies(self, tmp_path: Path) -> None:
        blobs = LocalBlobStore(tmp_path / "blobs")

        path = Path(blobs.put("amaco/aa/bb.webp", b"bytes", "image/webp"))

        assert path == tmp_path / "blobs" / "amaco" / "aa" / "bb.webp"
        assert path.read_bytes() == b"bytes"

    def test_remove_ignores_a_key_that_was_never_written(self, tmp_path: Path) -> None:
        blobs = LocalBlobStore(tmp_path / "blobs")
        blobs.put("a.webp", b"bytes", "image/webp")

        blobs.remove(["a.webp", "never-written.webp"])

        assert blobs.exists("a.webp") is False


def local_settings(blob_dir: Path) -> Settings:
    """Credentials absent, cache directory under tmp_path — `blob_dir` defaults to
    `./.blobs` relative to the working directory, and `LocalBlobStore` creates its root."""
    return Settings(_env_file=None, supabase_url="", secret_key="", blob_dir=blob_dir)


class TestBlobStoreFor:
    def test_credentials_select_the_per_manufacturer_private_bucket(
        self, existing_buckets: list[str], tmp_path: Path
    ) -> None:
        known = {"a/b.webp"}
        settings = Settings(
            _env_file=None, supabase_url=URL, secret_key=KEY, blob_dir=tmp_path
        )

        store = blob_store_for(settings, "amaco", known_keys=known)

        try:
            assert isinstance(store, SupabaseBlobStore)
            assert store._bucket_id == "mudbud_amaco"
            # Threaded, not copied: the caller's set is what later lookups consult.
            assert store._known is known
        finally:
            store.close()

    def test_no_credentials_fall_back_to_the_configured_directory(self, tmp_path: Path) -> None:
        store = blob_store_for(local_settings(tmp_path / "cfg"), "amaco")

        assert isinstance(store, LocalBlobStore)
        assert Path(store.put("k.webp", b"x", "image/webp")).parent == tmp_path / "cfg"

    def test_an_explicit_blob_dir_overrides_the_configured_one(self, tmp_path: Path) -> None:
        store = blob_store_for(
            local_settings(tmp_path / "cfg"), "amaco", blob_dir=tmp_path / "override"
        )

        assert Path(store.put("k.webp", b"x", "image/webp")).parent == tmp_path / "override"

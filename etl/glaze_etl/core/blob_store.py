"""Where processed image bytes are kept.

A blob store is the one part of the media stage that changes for outside reasons — a
storage vendor, a bucket policy, a credential model — so it lives behind a protocol and
apart from the code that downloads and measures images. `MediaProcessor` only ever needs
`exists` and `put`, which is what makes running the whole pipeline against the filesystem
before any Supabase credentials exist a one-line substitution.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

import httpx
import structlog

log = structlog.get_logger(__name__)


class BlobStore(Protocol):
    def exists(self, key: str) -> bool: ...

    def put(self, key: str, data: bytes, content_type: str) -> str: ...


class LocalBlobStore:
    """Filesystem-backed store, for development and for the first real crawl.

    Keeps the pipeline runnable before Supabase credentials exist. Same interface, so
    swapping in the hosted store later changes one line at the call site.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        root.mkdir(parents=True, exist_ok=True)

    def exists(self, key: str) -> bool:
        return (self._root / key).exists()

    def put(self, key: str, data: bytes, content_type: str) -> str:
        path = self._root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return str(path)


class SupabaseBlobStore:
    """A **private** Supabase Storage bucket. Reads go through time-limited signed URLs.

    Private is the whole point. These are AMACO's photographs; caching them is what makes
    cropping the coat composites possible, but a public bucket would be a straightforward
    rehost. A private bucket plus signed URLs keeps the cache an implementation detail and
    keeps the app pointing at attributed content.

    Writes use the service role, so this never runs with the anon key the app holds.
    """

    def __init__(
        self,
        url: str,
        service_key: str,
        bucket: str,
        *,
        timeout: int = 60,
        known_keys: set[str] | None = None,
    ) -> None:
        from storage3 import SyncStorageClient

        # The timeout goes on the http client, not the storage client: storage3 2.31
        # deprecated its own `timeout` parameter. We own the client, so we must close it —
        # see `close()`.
        # Trailing slash matters: storage3 warns and rewrites the URL without one.
        self._http = httpx.Client(timeout=timeout)
        self._storage = SyncStorageClient(
            f"{url.rstrip('/')}/storage/v1/",
            {"apikey": service_key, "Authorization": f"Bearer {service_key}"},
            http_client=self._http,
        )
        self._bucket_id = bucket
        # Keys already in the bucket. Supplied up front because the alternative is one HTTP
        # round trip per blob just to ask "do you have this?" — 1294 of them on a full load,
        # which dominated the run at roughly 12 minutes of pure latency. The caller can answer
        # the same question with a single query against storage.objects.
        self._known: set[str] = known_keys if known_keys is not None else set()
        self._ensure_bucket()

    def _ensure_bucket(self) -> None:
        """Create the bucket if absent, always private."""
        existing = {bucket.id for bucket in self._storage.list_buckets()}
        if self._bucket_id not in existing:
            self._storage.create_bucket(self._bucket_id, options={"public": False})
            log.info("storage.bucket_created", bucket=self._bucket_id, public=False)

    @property
    def _bucket(self) -> Any:
        return self._storage.from_(self._bucket_id)

    def exists(self, key: str) -> bool:
        if key in self._known:
            return True
        try:
            found = bool(self._bucket.exists(key))
        # storage3 raises for a missing object rather than returning False.
        except Exception:
            return False
        if found:
            self._known.add(key)
        return found

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self._bucket.upload(
            key,
            data,
            {"content-type": content_type, "upsert": "true", "cache-control": "31536000"},
        )
        self._known.add(key)
        return key

    def signed_url(self, key: str, expires_in: int = 3600) -> str:
        """A time-limited read URL. The app never receives a permanent one."""
        response = self._bucket.create_signed_url(key, expires_in)
        return str(response["signedURL"])

    def close(self) -> None:
        """Release the HTTP connection pool. A crawl opens one store and many sockets."""
        self._http.close()

    def __enter__(self) -> SupabaseBlobStore:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

"""Downloading glaze photographs, deriving sizes, and measuring their colour.

Images are cached rather than hotlinked because the coats composites have to be cropped
into per-thickness tiles, which cannot be done from a remote URL. That makes attribution
a storage concern, not just a UI one: every blob keeps its source URL and licence status,
and the bucket is private behind signed URLs rather than a public rehost.

Deduplication is by content hash, not URL. AMACO hangs the same line colour chart on
every glaze in the line, so a naive per-product download would fetch and re-measure one
2048px JPEG sixty times.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
import structlog
from PIL import Image, UnidentifiedImageError

from glaze_etl.core.color import ColorReading, read_color
from glaze_etl.core.composite_splitter import (
    BBox,
    sample_region,
    split_coats_composite,
)

log = structlog.get_logger(__name__)

DERIVATIVES: dict[str, int] = {
    # Prefix -> longest side. Mirrors what the app actually needs: a detail hero, a
    # results-grid thumb, and a blur-up placeholder.
    "l": 1280,
    "m": 640,
    "s": 240,
    "p": 20,
}


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

    def __init__(self, url: str, service_key: str, bucket: str, *, timeout: int = 60) -> None:
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
        try:
            return bool(self._bucket.exists(key))
        # storage3 raises for a missing object rather than returning False.
        except Exception:
            return False

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self._bucket.upload(
            key,
            data,
            {"content-type": content_type, "upsert": "true", "cache-control": "31536000"},
        )
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


@dataclass(frozen=True)
class RegionReading:
    """One sub-region of a composite: where it is, and what colour it is."""

    bbox: BBox
    color: ColorReading
    ordinal: int
    """0-based position left to right, which is AMACO's thin-to-thick order."""


@dataclass(frozen=True)
class StoredImage:
    sha256: str
    width: int
    height: int
    storage_key: str
    color: ColorReading
    reused: bool = False
    """True when this hash was already in the store, so nothing was re-uploaded."""
    regions: tuple[RegionReading, ...] = ()
    """Per-coat regions, when this was a composite the splitter could resolve."""
    split_refusal: str = ""
    """Why the split was declined, for the parse_issues row. Empty when not attempted."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def storage_key(digest: str, prefix: str = "l") -> str:
    """`l/ab/abcdef...jpg` — sharded two levels so no directory holds every image."""
    return f"{prefix}/{digest[:2]}/{digest}.jpg"


class MediaProcessor:
    def __init__(self, client: httpx.AsyncClient, blobs: BlobStore) -> None:
        self._client = client
        self._blobs = blobs

    async def process(self, source_url: str, *, split_composite: bool = False) -> StoredImage:
        """Download once, derive sizes, measure colour.

        Colour is measured from the `m` derivative rather than the original: 640px is
        ample for a two-cluster k-means, and it keeps the measurement independent of
        whatever resolution AMACO happened to upload.
        """
        response = await self._client.get(source_url)
        response.raise_for_status()
        data = response.content
        digest = sha256_bytes(data)

        try:
            original = Image.open(io.BytesIO(data))
            original.load()
        except (UnidentifiedImageError, OSError) as exc:
            raise ValueError(f"not a readable image: {source_url}") from exc

        key = storage_key(digest)
        medium = _resize(original, DERIVATIVES["m"])

        # Splitting works on the full-size original, not the 640px derivative: the caption
        # strip the splitter keys off is small text, and downsampling blurs it into the
        # background.
        regions: tuple[RegionReading, ...] = ()
        refusal = ""
        if split_composite:
            split = split_coats_composite(original)
            if split.ok:
                regions = tuple(
                    RegionReading(box, read_color(sample_region(original, box)), index)
                    for index, box in enumerate(split.boxes)
                )
            else:
                refusal = split.reason

        if self._blobs.exists(key):
            # Same bytes already held — AMACO reuses line charts across every product in
            # the line, so this is the common path, not an edge case.
            log.debug("media.reused", sha256=digest[:12], url=source_url)
            return StoredImage(
                sha256=digest,
                width=original.width,
                height=original.height,
                storage_key=key,
                color=read_color(medium),
                reused=True,
                regions=regions,
                split_refusal=refusal,
            )

        for prefix, longest_side in DERIVATIVES.items():
            derived = medium if prefix == "m" else _resize(original, longest_side)
            quality = 20 if prefix == "p" else 82
            self._blobs.put(
                storage_key(digest, prefix), _encode(derived, quality), "image/jpeg"
            )

        log.info("media.stored", sha256=digest[:12], size=f"{original.width}x{original.height}")
        return StoredImage(
            sha256=digest,
            width=original.width,
            height=original.height,
            storage_key=key,
            color=read_color(medium),
            regions=regions,
            split_refusal=refusal,
        )


def _resize(image: Image.Image, longest_side: int) -> Image.Image:
    converted = image.convert("RGB")
    if max(converted.size) <= longest_side:
        return converted
    copy = converted.copy()
    copy.thumbnail((longest_side, longest_side), Image.Resampling.LANCZOS)
    return copy


def _encode(image: Image.Image, quality: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True)
    return buffer.getvalue()

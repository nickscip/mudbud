"""MediaProcessor, driven from local fixture bytes through a mock transport."""

from __future__ import annotations

import io
from pathlib import Path

import httpx
import pytest
from PIL import Image

from glaze_etl.core.media import (
    DERIVATIVES,
    LocalBlobStore,
    MediaProcessor,
    sha256_bytes,
    storage_key,
)

IMAGES = Path(__file__).parent / "fixtures" / "images"
URL = "https://cdn11.bigcommerce.com/s-a0h9fhqogk/images/stencil/1280x1280/x.jpg"


def image_bytes(name: str = "pc20-label-chip") -> bytes:
    return (IMAGES / f"{name}.jpg").read_bytes()


def build(payload: bytes, root: Path) -> tuple[MediaProcessor, LocalBlobStore, list[str]]:
    requested: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, content=payload, headers={"Content-Type": "image/jpeg"})

    blobs = LocalBlobStore(root)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    return MediaProcessor(client, blobs), blobs, requested


class TestProcessing:
    async def test_writes_every_derivative(self, tmp_path: Path) -> None:
        processor, _, _ = build(image_bytes(), tmp_path)

        stored = await processor.process(URL)

        for prefix in DERIVATIVES:
            assert (tmp_path / storage_key(stored.sha256, prefix)).exists(), prefix

    async def test_derivatives_shrink_monotonically(self, tmp_path: Path) -> None:
        processor, _, _ = build(image_bytes(), tmp_path)
        stored = await processor.process(URL)

        sizes = {}
        for prefix in DERIVATIVES:
            with Image.open(tmp_path / storage_key(stored.sha256, prefix)) as derived:
                sizes[prefix] = max(derived.size)

        assert sizes["l"] >= sizes["m"] > sizes["s"] > sizes["p"]
        assert sizes["p"] <= 20, "placeholder must stay tiny enough to inline"

    async def test_reports_the_original_dimensions_not_the_derivative(
        self, tmp_path: Path
    ) -> None:
        payload = image_bytes()
        processor, _, _ = build(payload, tmp_path)

        stored = await processor.process(URL)

        with Image.open(io.BytesIO(payload)) as original:
            assert (stored.width, stored.height) == original.size

    async def test_measures_colour(self, tmp_path: Path) -> None:
        processor, _, _ = build(image_bytes(), tmp_path)
        stored = await processor.process(URL)
        assert stored.color.dominant_hex.startswith("#")
        assert stored.color.pixels_sampled > 0


class TestDeduplication:
    async def test_identical_bytes_are_not_re_uploaded(self, tmp_path: Path) -> None:
        """AMACO hangs one line chart on every glaze in the line, so this is the
        common path — a per-product download would re-measure the same JPEG 60 times."""
        processor, _, _ = build(image_bytes(), tmp_path)

        first = await processor.process(URL)
        second = await processor.process(URL + "?different-query")

        assert first.sha256 == second.sha256
        assert not first.reused
        assert second.reused

    async def test_reused_images_still_report_colour(self, tmp_path: Path) -> None:
        """The dedupe path must not return a hollow result — the second glaze needs the
        same measurement to build its own appearance row."""
        processor, _, _ = build(image_bytes(), tmp_path)

        first = await processor.process(URL)
        second = await processor.process(URL)

        assert second.color.dominant_hex == first.color.dominant_hex

    async def test_different_images_get_different_keys(self, tmp_path: Path) -> None:
        one, _, _ = build(image_bytes("pc20-label-chip"), tmp_path)
        two, _, _ = build(image_bytes("pc30-application-tiles"), tmp_path)

        assert (await one.process(URL)).sha256 != (await two.process(URL)).sha256

    def test_keys_are_sharded_so_no_directory_holds_everything(self) -> None:
        digest = sha256_bytes(b"whatever")
        assert storage_key(digest, "l") == f"l/{digest[:2]}/{digest}.jpg"


class TestFailures:
    async def test_non_image_payload_is_rejected_clearly(self, tmp_path: Path) -> None:
        processor, _, _ = build(b"<html>404 page</html>", tmp_path)

        with pytest.raises(ValueError, match="not a readable image"):
            await processor.process(URL)

    async def test_http_error_propagates(self, tmp_path: Path) -> None:
        def handle(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        processor = MediaProcessor(
            httpx.AsyncClient(transport=httpx.MockTransport(handle)), LocalBlobStore(tmp_path)
        )

        with pytest.raises(httpx.HTTPStatusError):
            await processor.process(URL)

"""Splitter behaviour against real AMACO composites.

The split is driven by the caption strip, not by tile geometry — see the module docstring
for the measurements that ruled geometry out. These tests pin both halves of the contract:
it resolves the composites it should, and it refuses everything else rather than inventing
a split.
"""

from __future__ import annotations

import itertools
from pathlib import Path

import pytest
from PIL import Image

from glaze_etl.core.color import read_color
from glaze_etl.core.composite_splitter import (
    BBox,
    caption_columns,
    sample_region,
    split_coats_composite,
)

IMAGES = Path(__file__).parent / "fixtures" / "images"
COMPOSITES = ["pc20-application-tiles", "pc30-application-tiles"]


def load(name: str) -> Image.Image:
    return Image.open(IMAGES / f"{name}.jpg")


class TestCaptionDetection:
    @pytest.mark.parametrize("name", COMPOSITES)
    def test_finds_exactly_three_caption_blocks(self, name: str) -> None:
        """Light / Slightly Light / Slightly Heavy, separated by ~150px against ~6px word
        spacing — the one signal in these images that cleanly isolates three tiles."""
        import numpy as np

        with load(name) as image:
            gray = np.asarray(image.convert("RGB"), dtype=np.uint8).mean(axis=2)
        assert len(caption_columns(gray)) == 3

    def test_no_captions_on_a_single_vessel_photo(self) -> None:
        import numpy as np

        with load("pc56-over-pcf54-32m-vase") as image:
            gray = np.asarray(image.convert("RGB"), dtype=np.uint8).mean(axis=2)
        assert len(caption_columns(gray)) != 3


class TestSplitting:
    @pytest.mark.parametrize("name", COMPOSITES)
    def test_resolves_three_tiles(self, name: str) -> None:
        with load(name) as image:
            result = split_coats_composite(image)
        assert result.ok, result.reason
        assert len(result.boxes) == 3

    @pytest.mark.parametrize("name", COMPOSITES)
    def test_tiles_are_equal_width_and_abutting(self, name: str) -> None:
        """They are cut from one slab and photographed together, so equal thirds of the
        tile row is exact rather than an approximation."""
        with load(name) as image:
            boxes = split_coats_composite(image).boxes
        widths = [box.width for box in boxes]
        assert max(widths) - min(widths) <= 2
        for left, right in itertools.pairwise(boxes):
            assert right.left == left.right

    @pytest.mark.parametrize("name", COMPOSITES)
    def test_boxes_are_ordered_left_to_right(self, name: str) -> None:
        with load(name) as image:
            boxes = split_coats_composite(image).boxes
        assert list(boxes) == sorted(boxes, key=lambda box: box.left)

    @pytest.mark.parametrize("name", COMPOSITES)
    def test_the_vessel_is_excluded(self, name: str) -> None:
        """AMACO stands a thrown pot in front of the rightmost tile. Requiring a column to
        be filled for the *whole* row height is what separates them — the vessel occupies
        only the lower part of those rows. Before this, the third crop contained a cup rim."""
        with load(name) as image:
            boxes = split_coats_composite(image).boxes
            assert boxes[-1].right < image.width - 100, "box ran to the frame edge"

    @pytest.mark.parametrize("name", COMPOSITES)
    def test_each_tile_measures_a_distinct_colour(self, name: str) -> None:
        """Different thicknesses of the same glaze genuinely look different — that is the
        entire premise. Identical readings would mean the crops overlap."""
        with load(name) as image:
            boxes = split_coats_composite(image).boxes
            hexes = [read_color(sample_region(image, box)).dominant_hex for box in boxes]
        assert len(set(hexes)) == 3, hexes

    def test_blue_rutile_breaks_brown_then_floats_blue(self) -> None:
        """AMACO's own copy: "a flowing light blue where thick... breaks brown where
        thinner". Measured 23.9 / 54.9 / 48.1 in L*, so the real signal is a large step at
        the *first* coat and little after it.

        An earlier version of this test asserted monotonically rising lightness, which was
        an assumption rather than an observation, and the measurement contradicted it. The
        thin tile being much darker is the claim actually supported.
        """
        with load("pc20-application-tiles") as image:
            boxes = split_coats_composite(image).boxes
            readings = [read_color(sample_region(image, box)) for box in boxes]
        lightness = [reading.dominant.l for reading in readings]
        assert lightness[0] < lightness[1] - 20, lightness
        assert lightness[0] < lightness[2] - 20, lightness
        # The thin coat reads warm (brown), the thicker ones cool (blue).
        assert readings[0].dominant.b > 0, "thin coat should be warm/brown"
        assert readings[1].dominant.b < readings[0].dominant.b

    def test_thickness_does_not_simply_mean_lighter(self) -> None:
        """A guard against generalising the previous test. PC-30 Temmoku runs dark, then
        gold, then dark green-black, so no monotonic rule holds across glazes."""
        with load("pc30-application-tiles") as image:
            boxes = split_coats_composite(image).boxes
            lightness = [read_color(sample_region(image, box)).dominant.l for box in boxes]
        assert lightness[1] > lightness[0]
        assert lightness[1] > lightness[2]


class TestRefusals:
    """A refusal is always safe: the caller keeps one whole-image appearance."""

    def test_label_chip_is_not_a_composite(self) -> None:
        with load("pc20-label-chip") as image:
            result = split_coats_composite(image)
        assert not result.ok
        assert "background" in result.reason

    def test_single_vessel_is_not_a_composite(self) -> None:
        with load("pc56-over-pcf54-32m-vase") as image:
            result = split_coats_composite(image)
        assert not result.ok
        assert result.boxes == ()

    def test_blank_image_is_refused(self) -> None:
        result = split_coats_composite(Image.new("RGB", (600, 400), (255, 255, 255)))
        assert not result.ok

    def test_every_refusal_explains_itself(self) -> None:
        """The reason lands in a parse_issues row, so it has to be actionable."""
        for name in ("pc20-label-chip", "pc56-over-pcf54-32m-vase"):
            with load(name) as image:
                result = split_coats_composite(image)
            assert result.reason
            assert result.diagnostics

    @pytest.mark.parametrize(
        "name",
        [*COMPOSITES, "pc20-label-chip", "pc56-over-pcf54-32m-vase"],
    )
    def test_never_returns_a_partial_split(self, name: str) -> None:
        """Three boxes or none. Two would silently mislabel thickness."""
        with load(name) as image:
            result = split_coats_composite(image)
        assert len(result.boxes) in (0, 3)
        assert result.ok == (len(result.boxes) == 3)


class TestSampling:
    def test_crop_is_inset_from_the_edges(self) -> None:
        """Edges catch rim pooling, cast shadow, and background bleed."""
        with load("pc20-label-chip") as image:
            cropped = sample_region(image, BBox(0, 0, 1000, 800), inset=0.2)
        assert cropped.width == pytest.approx(1000 * 0.6, abs=2)

    def test_crop_is_biased_above_the_vessel(self) -> None:
        """The vessel rim intrudes at ~73% of the box height, so the crop stops short of
        the bottom. A flat test tile is uniform vertically, so nothing is lost."""
        with load("pc20-label-chip") as image:
            cropped = sample_region(image, BBox(0, 0, 1000, 1000), inset=0.2)
        assert cropped.height < 1000 * 0.5

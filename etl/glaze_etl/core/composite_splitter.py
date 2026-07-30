"""Carves AMACO's application-tile composites into one region per coat thickness.

AMACO photographs application thickness as a single JPEG holding three tiles side by side
on a white background, captioned *Light / Slightly Light / Slightly Heavy Coat of Glaze*,
usually with a thrown vessel beside them. The thickness axis therefore lives inside the
pixels, not in any metadata — splitting the image is the only way to get one appearance row
per coat, and thickness is the axis potters most often get wrong.

**The captions are the signal, not the geometry.** Every cheap geometric separation was
tried against `tests/fixtures/images/pc20-*.jpg` and `pc30-*.jpg` (both 1024x768) and ruled
out by measurement:

  * The three tiles **abut** — no background columns between them, so connected-component
    labelling merges all three into one blob covering 77% of the frame.
  * **No horizontal cut isolates the tile row.** Tiles occupy rows 105..520, the vessel rows
    104..722; they start on effectively the same row.
  * **No internal vertical gutter exists**, at any row band.

The caption strip does separate cleanly. Above the tiles, the only ink is the three labels,
and they are divided by two gaps of ~150-170px against ~6px word spacing — measured at
x=164 and x=452 on PC-20, x=165 and x=462 on PC-30. Each caption is centred over its tile,
so three text blocks give three tile columns directly, and the vessel is excluded for free
because it has no caption above it.

Note this deliberately **locates** the captions without reading them. Left-to-right is
always thin-to-thick, so their positions are all the information needed; OCR would add a
system dependency and a new way to be wrong.

The split is still asserted rather than assumed. Anything that does not look like exactly
three comparable captioned tiles is declined with a reason, and the caller keeps one
whole-image appearance plus a parse issue. A wrong crop would silently attach the wrong
colour to the wrong thickness, which is worse than no data at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from scipy import ndimage

BackgroundMask = np.ndarray


@dataclass(frozen=True)
class BBox:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    @property
    def area(self) -> int:
        return self.width * self.height

    def as_dict(self) -> dict[str, int]:
        return {"left": self.left, "top": self.top, "right": self.right, "bottom": self.bottom}


@dataclass(frozen=True)
class SplitResult:
    boxes: tuple[BBox, ...] = ()
    """Left-to-right. What that order *means* is the adapter's `coat_order`. Empty on
    refusal."""
    ok: bool = False
    reason: str = ""
    diagnostics: dict[str, object] = field(default_factory=dict)


_BACKGROUND_LUMA = 235
"""Above this on every channel is studio white."""

_TEXT_LUMA = 160
"""Caption ink is well below this; anti-aliased tile edges are not."""

_CAPTION_SEARCH_FRACTION = 0.14
"""Captions sit in the top ~14% of the frame, above where any tile begins."""

_MIN_CAPTION_GAP = 40
"""Floor for a gap to count as separating captions at all. Word spacing inside a caption is
~6px and the gaps between captions are ~150px, so this sits well clear of both — but see
`caption_columns`, which then takes the two *largest* gaps rather than every gap over this
threshold. A fixed threshold alone failed on PC-12, whose wider labels ("Slightly Light Coat
of Glaze") pack closer together and merged into 2 blocks."""

_ROW_AGREEMENT = 0.25
"""Tiles are photographed together, so their vertical extents agree closely."""


def _background_mask(rgb: np.ndarray) -> BackgroundMask:
    return rgb.min(axis=2) >= _BACKGROUND_LUMA


def caption_columns(gray: np.ndarray) -> list[tuple[int, int]]:
    """Find the x-ranges of the caption blocks, left to right.

    Works on ink position only — no character recognition. Returns [] when the caption strip
    does not look like discrete text blocks.
    """
    height = gray.shape[0]
    strip = gray[: int(height * _CAPTION_SEARCH_FRACTION)] < _TEXT_LUMA
    if not strip.any():
        return []

    # Discard rows dense enough to be a tile edge rather than text.
    text_rows = strip.mean(axis=1) < 0.35
    inked = (strip & text_rows[:, None]).any(axis=0)
    columns = np.where(inked)[0]
    if columns.size == 0:
        return []

    # Exactly three captions are expected, so cut at the two widest gaps rather than at
    # every gap over a threshold. That is robust to labels of differing width.
    gaps = [
        (int(columns[i + 1] - columns[i]), i)
        for i in range(columns.size - 1)
        if columns[i + 1] - columns[i] > _MIN_CAPTION_GAP
    ]
    if len(gaps) < 2:
        return [(int(columns.min()), int(columns.max()))]
    gaps.sort(reverse=True)
    cut_after = sorted(index for _, index in gaps[:2])

    blocks: list[tuple[int, int]] = []
    start = 0
    for index in cut_after:
        blocks.append((int(columns[start]), int(columns[index])))
        start = index + 1
    blocks.append((int(columns[start]), int(columns[-1])))
    return blocks


def _tile_rows(background: BackgroundMask, left: int, right: int) -> tuple[int, int] | None:
    """Vertical extent of the tile under one caption, as the longest solid run."""
    strip = ~background[:, left:right]
    solid = strip.mean(axis=1) > 0.9
    if not solid.any():
        return None
    labels, count = ndimage.label(solid)
    if count == 0:
        return None
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    rows = np.where(labels == int(np.argmax(sizes)) + 1)[0]
    return int(rows.min()), int(rows.max()) + 1


def _tile_row_extent(
    background: BackgroundMask, top: int, bottom: int
) -> tuple[int, int] | None:
    """Horizontal extent of the tile row, with the vessel excluded.

    A column counts only if it is filled for nearly the *whole* row height. That single
    condition is what separates the tiles from the vessel beside them: the vessel occupies
    only the lower part of these rows, so its columns fail while the tiles' pass. Measured
    x42..879 on PC-20 and x35..879 on PC-30, in both cases one clean run.
    """
    band = ~background[top:bottom]
    solid = band.mean(axis=0) > 0.92
    if not solid.any():
        return None
    labels, count = ndimage.label(solid)
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    columns = np.where(labels == int(np.argmax(sizes)) + 1)[0]
    return int(columns.min()), int(columns.max()) + 1


def _dense_row_band(foreground: np.ndarray) -> tuple[int, int] | None:
    """Longest run of rows carrying a lot of ink — the tile row, captions excluded."""
    dense = foreground.mean(axis=1) > 0.30
    if not dense.any():
        return None
    labels, count = ndimage.label(dense)
    sizes = ndimage.sum(dense, labels, range(1, count + 1))
    rows = np.where(labels == int(np.argmax(sizes)) + 1)[0]
    return int(rows.min()), int(rows.max()) + 1


def separated_tiles(background: BackgroundMask) -> tuple[BBox, ...]:
    """Handle the layout whose tiles are separated by white gutters.

    AMACO uses at least two composite designs. The Cosmos line puts a title on top, three
    *detached* tiles in a row, and the coat count under each one; Potter's Choice puts the
    captions above three *abutting* tiles with a thrown vessel beside them. Detached tiles
    are much easier — the gutters do the work — so this is tried first, and returns empty
    when the layout is not that shape.

    Measured on CO-6 Supernova (1280x640): rows 188..451, three runs at 111-365, 514-772 and
    914-1173, all ~255px wide.
    """
    foreground = ~background
    band = _dense_row_band(foreground)
    if band is None:
        return ()
    top, bottom = band
    width = background.shape[1]

    solid = foreground[top:bottom].mean(axis=0) > 0.90
    if not solid.any():
        return ()
    labels, count = ndimage.label(solid)
    runs: list[tuple[int, int]] = []
    for index in range(1, count + 1):
        columns = np.where(labels == index)[0]
        if columns.size > width * 0.04:
            runs.append((int(columns.min()), int(columns.max()) + 1))
    if len(runs) != 3:
        return ()

    widths = [right - left for left, right in runs]
    if max(widths) - min(widths) > _ROW_AGREEMENT * max(widths):
        return ()
    return tuple(BBox(left, top, right, bottom) for left, right in runs)


def split_coats_composite(image: Image.Image) -> SplitResult:
    """Locate the three coat tiles, or refuse and explain.

    Boxes come back left to right. Mapping them onto coat levels is the adapter's job
    (`coat_order`) — only an adapter that classifies an image as COATS_COMPOSITE routes
    it here, so this stays an AMACO-layout utility a source opts into, not generic code
    asserting how every manufacturer photographs thickness.
    """
    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    gray = rgb.mean(axis=2)
    height, width = gray.shape

    background = _background_mask(rgb)
    if background.mean() < 0.15:
        return SplitResult(
            reason="no white studio background; not an AMACO composite layout",
            diagnostics={"background_fraction": round(float(background.mean()), 3)},
        )

    # Detached-tile layouts resolve from geometry alone, so try that before the captions.
    detached = separated_tiles(background)
    if detached:
        return SplitResult(
            boxes=detached,
            ok=True,
            reason="3 tiles separated by gutters",
            diagnostics={"layout": "separated"},
        )

    blocks = caption_columns(gray)
    if len(blocks) != 3:
        return SplitResult(
            reason=f"expected 3 caption blocks above the tiles, found {len(blocks)}",
            diagnostics={"caption_blocks": blocks},
        )

    # The captions establish *that* there are three tiles, which is what they are reliable
    # for. The boundaries come from geometry instead: the caption blocks vary in width with
    # their text ("Light" against "Slightly Heavy"), so their centres are not evenly spaced
    # and make poor cut lines.
    #
    # Row extent first, measured under the two leftmost captions — the vessel sits beneath
    # the rightmost tile and overlaps it vertically. Tiles are photographed together, so
    # requiring those two to agree on height is a real check, not a convenience.
    extents = [_tile_rows(background, blocks[i][0], blocks[i][1]) for i in range(2)]
    if any(extent is None for extent in extents):
        return SplitResult(
            reason="could not find a solid tile under the first two captions",
            diagnostics={"caption_blocks": blocks},
        )
    first, second = (extent for extent in extents if extent is not None)
    first_height, second_height = first[1] - first[0], second[1] - second[0]
    if abs(first_height - second_height) > _ROW_AGREEMENT * max(first_height, second_height):
        return SplitResult(
            reason="the first two tiles disagree on height; not one photographed row",
            diagnostics={"first": first, "second": second},
        )

    top = max(first[0], second[0])
    bottom = min(first[1], second[1])
    if bottom - top < height * 0.15:
        return SplitResult(
            reason="tile row too shallow to sample",
            diagnostics={"top": top, "bottom": bottom},
        )

    span = _tile_row_extent(background, top, bottom)
    if span is None:
        return SplitResult(
            reason="no full-height tile row found",
            diagnostics={"top": top, "bottom": bottom},
        )
    left, right = span
    if right - left < width * 0.4:
        return SplitResult(
            reason="tile row too narrow for three tiles",
            diagnostics={"span": span},
        )

    # The tiles abut and are cut from the same slab, so equal thirds of the row is exact
    # rather than an approximation — and it keeps the vessel out of the rightmost box, which
    # extending to the frame edge did not.
    tile_width = (right - left) / 3
    boxes = tuple(
        BBox(int(left + i * tile_width), top, int(left + (i + 1) * tile_width), bottom)
        for i in range(3)
    )
    return SplitResult(
        boxes=boxes,
        ok=True,
        reason="3 abutting tiles under 3 captions",
        diagnostics={
            "layout": "captioned",
            "caption_blocks": blocks,
            "row_span": span,
            "tile_width": round(tile_width, 1),
        },
    )


def sample_region(
    image: Image.Image, box: BBox, inset: float = 0.18, bottom_limit: float = 0.62
) -> Image.Image:
    """Crop a region safely inside a tile, biased toward its upper half.

    Two separate reasons, both measured:

    * ``inset`` keeps the crop off the tile's edges, which catch rim pooling, the tile's own
      shadow, and white background bleeding in — all of which drag the measured colour away
      from the glaze.
    * ``bottom_limit`` stops the crop short of the bottom because AMACO stands the thrown
      vessel in front of the rightmost tile, and its rim intrudes at ~73% of the box height
      (y≈401 in a y106..510 box, on both PC-20 and PC-30). A flat test tile is uniform top to
      bottom, so sampling the upper part costs nothing and removes the vessel entirely —
      visible in the contact sheet as the cup rim that used to appear in every third crop.
    """
    dx = int(box.width * inset)
    top = box.top + int(box.height * inset)
    bottom = box.top + int(box.height * bottom_limit)
    return image.crop((box.left + dx, top, box.right - dx, bottom))

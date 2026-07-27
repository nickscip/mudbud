"""Measuring the colour of a fired glaze from a photograph.

Two decisions carry most of the weight here.

**Sample the centre, not the whole frame.** A test tile photograph is mostly tile, but
its edges hold rim pooling, the shadow it casts, and white background bleeding in. Glazy
sampled only the middle of its images for exactly this reason, and it is the difference
between measuring the glaze and measuring the studio.

**Work in LAB, not RGB.** Glazy ranked colour similarity by squared Euclidean distance
in raw RGB, which is why its colour search was mediocre: RGB distance does not track
perceived difference, so a pair of dark browns can sit further apart numerically than a
brown and a green that look nothing alike. LAB with CIEDE2000 is built for the question
"do these look the same to a person".
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
from PIL import Image
from sklearn.cluster import MiniBatchKMeans

with warnings.catch_warnings():
    # colour-science warns that its plotting API is unavailable without matplotlib.
    # We only use the colourimetry, so pulling in a plotting stack to silence a warning
    # would be the wrong trade.
    warnings.simplefilter("ignore")
    import colour


@dataclass(frozen=True)
class Lab:
    l: float  # noqa: E741 - L, a and b are the standard axis names for this space.
    a: float
    b: float

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.l, self.a, self.b)


@dataclass(frozen=True)
class ColorReading:
    """A glaze rarely has one colour, so two are measured.

    ``dominant`` is the largest cluster and ``secondary`` the next; on a break-and-pool
    glaze like Blue Rutile that pair captures most of what a potter is looking at.
    """

    dominant: Lab
    secondary: Lab | None
    dominant_hex: str
    secondary_hex: str | None
    pixels_sampled: int


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB bytes -> CIE L*a*b* under D65, via colour-science."""
    normalised = np.asarray(rgb, dtype=np.float64) / 255.0
    xyz = colour.sRGB_to_XYZ(normalised)
    return np.asarray(colour.XYZ_to_Lab(xyz), dtype=np.float64)


def delta_e(first: Lab, second: Lab) -> float:
    """Perceptual distance. CIEDE2000, the current recommendation."""
    return float(
        colour.difference.delta_E_CIE2000(
            np.array(first.as_tuple()), np.array(second.as_tuple())
        )
    )


def to_hex(rgb: tuple[float, float, float]) -> str:
    r, g, b = (round(min(255.0, max(0.0, channel))) for channel in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def center_crop(image: Image.Image, fraction: float = 0.4) -> Image.Image:
    """Keep the middle `fraction` of each axis."""
    width, height = image.size
    half_w, half_h = int(width * fraction / 2), int(height * fraction / 2)
    cx, cy = width // 2, height // 2
    return image.crop((cx - half_w, cy - half_h, cx + half_w, cy + half_h))


def read_color(
    image: Image.Image,
    *,
    crop_fraction: float = 0.4,
    max_side: int = 200,
    drop_background: bool = True,
) -> ColorReading:
    """Measure the dominant and secondary colour of a glazed surface.

    Downsamples before clustering — k-means on a full 1280px frame costs far more than it
    adds, since we only want two representative colours.
    """
    sample = center_crop(image, crop_fraction).convert("RGB")
    sample.thumbnail((max_side, max_side))
    pixels = np.asarray(sample, dtype=np.uint8).reshape(-1, 3)

    if drop_background:
        # Studio white is not part of the glaze. Dropping it stops a tile photographed
        # against a bright backdrop from reading as a pale glaze.
        keep = pixels.min(axis=1) < 235
        if keep.sum() >= 32:
            pixels = pixels[keep]

    if len(pixels) == 0:
        raise ValueError("no sampleable pixels")

    clusters = 2 if len(pixels) >= 64 else 1
    kmeans = MiniBatchKMeans(
        n_clusters=clusters, n_init=3, random_state=0, batch_size=256
    ).fit(pixels)

    # Order by population so `dominant` really is the most of what you see.
    counts = np.bincount(kmeans.labels_, minlength=clusters)
    order = np.argsort(-counts)
    centers = kmeans.cluster_centers_[order]

    labs = srgb_to_lab(centers)
    dominant = Lab(*(float(v) for v in labs[0]))
    secondary = Lab(*(float(v) for v in labs[1])) if clusters > 1 else None

    return ColorReading(
        dominant=dominant,
        secondary=secondary,
        dominant_hex=to_hex(tuple(centers[0])),
        secondary_hex=to_hex(tuple(centers[1])) if clusters > 1 else None,
        pixels_sampled=len(pixels),
    )

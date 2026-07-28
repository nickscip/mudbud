"""What the pure stages hand to the writer.

These sit between measuring an image and storing it, so they live apart from both. Kept
out of `loader.py` because the pipeline and the media stage describe their results with
them and neither should have to import the database layer to do it.
"""

from __future__ import annotations

from dataclasses import dataclass

from glaze_etl.core.models import CoatLevel, ImageFacts


@dataclass(frozen=True)
class RegionPayload:
    """One coat-thickness region carved out of a composite."""

    coat_level: CoatLevel
    crop_bbox: dict[str, int]
    hex_dominant: str | None = None
    hex_secondary: str | None = None
    lab: tuple[float, float, float] | None = None
    lab_secondary: tuple[float, float, float] | None = None


@dataclass(frozen=True)
class ImagePayload:
    """One image, after the grammar read it and the media stage measured it."""

    facts: ImageFacts
    source_url: str
    raw_filename: str
    storage_path: str | None = None
    sha256: str | None = None
    width: int | None = None
    height: int | None = None
    hex_dominant: str | None = None
    hex_secondary: str | None = None
    lab: tuple[float, float, float] | None = None
    lab_secondary: tuple[float, float, float] | None = None
    regions: tuple[RegionPayload, ...] = ()
    """Set for a composite the splitter resolved. One appearance is written per region
    instead of one for the whole image."""

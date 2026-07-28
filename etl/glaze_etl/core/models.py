"""Contracts between pipeline stages.

Every stage boundary is a pydantic model so a malformed intermediate fails loudly at
the seam instead of silently corrupting a database row. The pure stages (Parser,
BadgeExtractor, ImageInterpreter, ColorNamer, Normalizer) consume and produce only
these types, which is what makes them testable against checked-in HTML fixtures.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class Frozen(BaseModel):
    """Immutable base. Stage outputs are values, never mutable accumulators."""

    model_config = ConfigDict(frozen=True, extra="forbid")


# --------------------------------------------------------------------------- enums


class ManufacturerKey(StrEnum):
    AMACO = "amaco"


class Confidence(StrEnum):
    """How much of an image's meaning the grammar actually resolved.

    HIGH  — every meaningful token matched a rule.
    MEDIUM— matched, but with a token the rules could not classify.
    LOW   — ambiguous, e.g. several glaze codes with no `over` to order them.
    """

    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class ImageRole(StrEnum):
    """What an image *is*, which decides how it gets turned into appearances."""

    LABEL_CHIP = "label_chip"
    """A single flat swatch of one glaze. The most reliable row we have."""

    COATS_COMPOSITE = "coats_composite"
    """Several tiles in one JPEG at different application thicknesses. Gets split."""

    LAYERED = "layered"
    """This glaze applied over another one."""

    IN_USE = "in_use"
    """The glaze on a thrown or built form rather than a flat tile."""

    LINE_CHART = "line_chart"
    """A whole-line color chart. Carries cone, opacity codes, and the clay caption."""

    OTHER = "other"


class CoatLevel(StrEnum):
    """AMACO's captions, verbatim, on the coats composites."""

    LIGHT = "light"
    SLIGHTLY_LIGHT = "slightly_light"
    SLIGHTLY_HEAVY = "slightly_heavy"
    HEAVY = "heavy"


class FormKind(StrEnum):
    FLAT_TILE = "flat_tile"
    TEXTURED_TILE = "textured_tile"
    CUP = "cup"
    BOWL = "bowl"
    MUG = "mug"
    PLATE = "plate"
    VASE = "vase"
    BASKET = "basket"
    OTHER = "other"


class Opacity(StrEnum):
    OPAQUE = "opaque"
    TRANSLUCENT = "translucent"
    TRANSPARENT = "transparent"


class Surface(StrEnum):
    GLOSS = "gloss"
    SATIN = "satin"
    MATTE = "matte"


# ------------------------------------------------------------------ crawl contracts


class Politeness(Frozen):
    """Crawl budget for a source, taken from its robots.txt."""

    crawl_delay_s: float = 10.0
    user_agent: str


class ProductRef(Frozen):
    """A product we know exists, before we have fetched it."""

    url: HttpUrl
    external_id: str
    """Stable per-source key. For AMACO this is the URL slug."""
    lastmod: datetime | None = None


class RawSnapshot(Frozen):
    """An immutable record of one fetch.

    Snapshots exist so the filename grammar can be revised and replayed without
    re-crawling. Reparse reads these; it never touches the network.
    """

    url: HttpUrl
    fetched_at: datetime
    http_status: int
    body: str
    content_hash: str
    etag: str | None = None


# ------------------------------------------------------------------ parse contracts


class ParsedImage(Frozen):
    """One image referenced by a product page, before interpretation."""

    source_url: HttpUrl
    raw_filename: str
    """Basename with extension, as it appeared on the CDN. The grammar's only input."""
    alt: str | None = None
    title: str | None = None


class GlazeBadges(Frozen):
    """Properties read off the product page's icon images.

    Tri-state on purpose: ``None`` means the page said nothing, which is different
    from an explicit negative. Only ``False`` should be trusted as "not this".
    """

    opacity: Opacity | None = None
    surface: Surface | None = None
    food_safe: bool | None = None
    food_safe_under_glaze: bool | None = None
    """Underglazes that only become food safe once covered by a clear glaze."""
    food_safe_not_durable: bool | None = None
    """Food safe, but AMACO warns the surface will not wear well."""
    astm_d4236: bool | None = None
    """Conforms to the ASTM D-4236 art-materials labelling standard."""
    dinnerware_safe: bool | None = None
    lead_free: bool | None = None
    ap_seal: bool | None = None
    """ACMI AP (safe for all ages). ``False`` means the page showed the CL seal instead."""
    spray_safe: bool | None = None
    mixable: bool | None = None
    layerable: bool | None = None
    prop65: bool | None = None
    is_dipping: bool | None = None
    """Dry dipping-bucket formulation. AMACO warns these layer differently from brushing."""
    cone_declared: bool = False
    unknown_icons: tuple[str, ...] = ()
    """Icon basenames no rule matched. These become parse_issues, never silent drops."""


class ParsedProduct(Frozen):
    """A product page reduced to facts, with no interpretation of its images yet."""

    manufacturer: ManufacturerKey
    external_id: str
    product_url: HttpUrl
    code: str
    """Manufacturer SKU code, normalized: `PC-20`, `LG-65`."""
    name: str
    line_code: str | None = None
    """Glaze line the breadcrumb places this in: `PC`, `LG`."""
    line_name: str | None = None
    cone_category: str | None = None
    """The breadcrumb bracket the source files this line under, e.g. "Low Fire Glazes".
    Almost no SKU states its cone directly, so this is where most ranges come from."""
    breadcrumb: tuple[str, ...] = ()
    description: str | None = None
    price_min: float | None = None
    price_max: float | None = None
    availability: str | None = None
    images: tuple[ParsedImage, ...] = ()
    badges: GlazeBadges = GlazeBadges()


# -------------------------------------------------------------- image interpretation


class ImageFacts(Frozen):
    """What the filename grammar could prove about one image.

    Fields left ``None`` were not stated. The grammar never fills a gap by inference —
    an unresolved token lowers ``confidence`` and lands in ``unmatched_tokens``.
    """

    role: ImageRole
    subject_code: str | None = None
    """The glaze this image is primarily of."""
    layered_over_code: str | None = None
    """``subject_code`` sits on top of this one. Set only when `over` ordered them."""
    combination_codes: tuple[str, ...] = ()
    """Several codes with no `over` to order them. Recorded, not guessed at."""
    cone: str | None = None
    """Orton cone name as written: `6`, `05`. Never coerced to an int — `05` != `5`."""
    coat_level: CoatLevel | None = None
    """Only ever set by CompositeSplitter — thickness lives inside the pixels, not
    the filename."""
    clay_body_number: int | None = None
    """AMACO clay number, e.g. 16 (White Chocolate) or 32 (Dark Chocolate)."""
    form: FormKind | None = None
    tile_size: str | None = None
    credit: str | None = None
    confidence: Confidence = Confidence.LOW
    unmatched_tokens: tuple[str, ...] = ()
    evidence: dict[str, str] = Field(default_factory=dict)
    """rule name -> the token(s) that fired it. Persisted for audit and debugging."""

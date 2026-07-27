"""AMACO's own identifiers, transcribed from the live catalog.

These are closed sets on purpose. The grammar checks candidate matches against them
rather than accepting anything that looks structurally right — a filename fragment is
only a clay body if it names a clay AMACO actually sells.
"""

from __future__ import annotations

from glaze_etl.core.models import FormKind

GLAZE_LINE_CODES: tuple[str, ...] = (
    # Ordered longest-first: the code regex alternates over this tuple and Python's
    # regex engine takes the first alternative that matches, so "PCF-54" must be
    # offered "PCF" before "PC" or it parses as PC with a stray F.
    "PCF",
    "LUG",
    "TPL",
    "UG",
    "PC",
    "SM",
    "HF",
    "SH",
    "PG",
    "CO",
    "CR",
    "DL",
    "KI",
    "LG",
    "LM",
    "TP",
    "C",
    "O",
    "V",
    "F",
)

GLAZE_LINE_NAMES: dict[str, str] = {
    "PC": "Potter's Choice",
    "PCF": "Potter's Choice Flux",
    "C": "Celadon",
    "SM": "Satin Matte",
    "HF": "High Fire",
    "SH": "Shino",
    "PG": "Phase Glaze",
    "CO": "Cosmos",
    "CR": "Crawls",
    "DL": "Dipping & Layering",
    "KI": "Kiln Ice",
    "LG": "Low Fire Gloss",
    "LM": "Low Fire Matte",
    "O": "Opalescent",
    "V": "Velvet Underglaze",
    "UG": "Underglaze",
    "LUG": "Liquid Underglaze",
    "TP": "Teacher's Palette",
    "TPL": "Teacher's Palette Lustre",
    "F": "Fundamentals",
}

CLAY_BODIES: dict[int, tuple[str, str]] = {
    # AMACO number -> (name, color family). Verified against shop.amaco.com/clays/.
    # These appear in image filenames as "16M"/"32M" and in burned-in captions as
    # "White Chocolate No.16 Clay".
    11: ("A-Mix White Stoneware No. 11", "white"),
    16: ("White Chocolate No. 16", "white"),
    25: ("White Art Clay No. 25", "white"),
    30: ("Milk Chocolate No. 30", "buff"),
    32: ("Dark Chocolate No. 32", "dark"),
    38: ("White Stoneware No. 38", "white"),
    46: ("Buff Stoneware No. 46", "buff"),
    67: ("Sedona Red No. 67", "dark"),
    77: ("MST No. 77", "buff"),
}

FORM_KEYWORDS: dict[str, FormKind] = {
    "fishtile": FormKind.TEXTURED_TILE,
    "labeltile": FormKind.TEXTURED_TILE,
    "squaretile": FormKind.FLAT_TILE,
    "tile": FormKind.FLAT_TILE,
    "chip": FormKind.FLAT_TILE,
    "swatch": FormKind.FLAT_TILE,
    "sake": FormKind.CUP,
    "cup": FormKind.CUP,
    "bowl": FormKind.BOWL,
    "mug": FormKind.MUG,
    "mugs": FormKind.MUG,
    "plate": FormKind.PLATE,
    "vase": FormKind.VASE,
    "basket": FormKind.BASKET,
}

FLAT_SWATCH_WORDS: frozenset[str] = frozenset(
    {"chip", "swatch", "labeltile", "tile", "fishtile", "squaretile"}
)
"""Words that mean "this is a plain swatch of one glaze" — the label-chip signal."""

NOISE_WORDS: frozenset[str] = frozenset(
    {
        # Rendering / export cruft
        "web", "website", "websiteswatch", "hires", "hi", "res", "large", "small",
        "jpg", "jpeg", "png", "gif", "productpage", "productimages", "sized",
        "original", "copy", "final", "new", "updated", "px",
        # Descriptive words AMACO puts around the photo subject, not facts about it.
        "label", "sample", "glaze", "glazes", "and", "the", "with", "on",
        # Dimension leftovers the size rules already consumed
        "square", "x",
    }
)

BADGE_ICONS: dict[str, tuple[str, bool | str]] = {
    # CDN basename under /image-manager/ -> (GlazeBadges field, value).
    # Transcribed from the fixture corpus and confirmed by opening each icon; anything
    # absent here raises a parse issue rather than being dropped, so a new AMACO badge
    # surfaces for review instead of vanishing.
    "opaque-icon-web.png": ("opacity", "opaque"),
    "semitransparent-icon-web.png": ("opacity", "translucent"),
    "transparent-icon-web.png": ("opacity", "transparent"),
    "ap-logo.png": ("ap_seal", True),
    "cl-logo.png": ("ap_seal", False),
    "cone-logo.png": ("cone_declared", True),
    "cone05-logo.png": ("cone_declared", True),
    "spray-logo.png": ("spray_safe", True),
    "no-word-spray-logo.png": ("spray_safe", False),
    "no-words-spray-logo.png": ("spray_safe", False),
    "food-safe-logo-with-tm-with-words-black.png": ("food_safe", True),
    # A wordless fork-and-knife glyph — the same food-safe claim as the logo above.
    # Verified by opening it; the UUID filename makes it look unidentifiable.
    "no-words-c1294f51-0570-4c25-b629-7544961a7b2b.png": ("food_safe", True),
    "foodsafeunderaglaze-web.png": ("food_safe_under_glaze", True),
    "mixable-logo.png": ("mixable", True),
    "layering-logo-black.png": ("layerable", True),
    # AMACO spells this one "layerin" on some pages. Same claim, different asset.
    "layerinicon-web.png": ("layerable", True),
    # Dipping vs brushing formulation — AMACO's dry dipping buckets behave differently
    # and are labelled with their own icon.
    "dippingicon-web.png": ("is_dipping", True),
    # "Not safe to spray", in both the wordless and captioned variants.
    "no-words-notsafe-spray-symbol-black-tm-2014.png": ("spray_safe", False),
    "notsafe-spray-symbol-black-tm-2014.png": ("spray_safe", False),
    # Explicit NOT food safe. Distinct from an absent icon, which says nothing.
    "no-words-notfoodsafe-web-icon.png": ("food_safe", False),
    "food-safe-logo-not-with-tm-with-words-black-red-thick-line.png": ("food_safe", False),
    # Underglazes that become food safe only under a celadon, not under any clear glaze.
    "foodsafe-appliedoverceladons-web-final.png": ("food_safe_under_glaze", True),
    # Food safe, but AMACO warns the surface will not wear well — a real distinction
    # for anyone glazing a mug, so it gets its own field rather than folding into
    # food_safe and losing the caveat.
    "foodsafe-butnotdurable-web-final.png": ("food_safe_not_durable", True),
    # ASTM D-4236 is the art-materials labelling standard the ACMI seals certify against.
    "conformstoastm-d-4236-web.png": ("astm_d4236", True),
}

PROP65_ICON_PREFIX = "p65-icon-web"
"""Prop-65 icons carry a cache-busting suffix, so they match by prefix, not equality."""

PROP65_ICON_SUFFIX = "prop65warnings.png"
"""AMACO names one Prop-65 icon per hazardous constituent — `silica-`, `lithiumcarb-`,
`silica-titaniumdioxide-`. Matching the shared suffix covers the ones we have not seen
yet, since the claim is identical regardless of which material triggered it."""

CATEGORY_CONE_RANGE: dict[str, tuple[str, str]] = {
    # Breadcrumb category -> (cone from, cone to), as cone *names*.
    #
    # Cone is almost never a parseable field on an AMACO product page, so this is where
    # most glazes get their firing range. The source is the scraped breadcrumb rather
    # than a hardcoded per-line table, which keeps it honest: both entries below are
    # corroborated by AMACO's own published text — the LG line chart image is captioned
    # "Cone 05", and the Potter's Choice pages state "optimal results at Cone 5/6" with
    # "Cone 5 = 1186C / 2167F, Cone 6 = 1222C / 2232F".
    "Mid-High Fire Glazes": ("5", "6"),
    "Low Fire Glazes": ("05", "05"),
    # "Underglazes" is deliberately absent. Velvets fire across a much wider range than
    # either bracket above, and guessing its endpoints would be inventing data. Lines in
    # an unmapped category get a null range, which `cone_overlaps` treats as "matches any
    # cone", and a parse_issue records that the range is still unknown.
}

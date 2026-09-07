"""Mayco's closed vocabularies, transcribed from the live catalog on 2026-07-30.

Every table here was derived by sweeping all 651 products in the `fired` category through
the Store API and counting, not by recalling what Mayco sells. Where a number appears in a
comment it is a measurement, so a later re-derivation can be compared against it.
"""

from __future__ import annotations

from glaze_etl.core.models import FormKind

FIRED_PATH = "/product-category/color/fired/"
"""The branch of the category tree that holds fired glaze, as it appears in every
descendant's `link`. Matched as a path rather than by the `fired` slug because a product
deep in the branch does not necessarily list the intermediate term — see `is_glaze`."""

FIRED_CATEGORY_ID = 98
"""`product_cat` term id for `color/fired`. Mayco's category tree splits cleanly:
`color/fired/*` is glaze, `color/non-fired/*` is acrylics and metallics,
`color/fired-accessories/*` is wax resist and kiln wash, `forms/*` is bisque and
`tools/*` is brushes. 651 products carry it, out of 1055 in the product sitemap."""

EXCLUDED_CATEGORIES: frozenset[str] = frozenset({"product-kits", "non-fired"})
"""Categories that disqualify a product even though it sits under `fired`. Kits are
assortments of other SKUs — 21 of them, and they are exactly the products with no cone
statement (EZKIT1, OSKIT1, SW2023KT). `non-fired` appears on one cross-listed product.
Leaves 630 glazes."""

LINE_IGNORED_CATEGORIES: frozenset[str] = frozenset(
    {"color", "fired", "new-colors", "new-stoneware-glazes-colors", "discontinued-products"}
)
"""Marketing and structural terms that are not lines. `new-colors` rotates with whatever
Mayco is promoting, so treating it as a line would reshuffle the catalog every crawl."""


CATEGORY_CONE_RANGE: dict[str, tuple[str, str]] = {
    # Line slug -> (coolest, hottest) Orton cone name, as *Mayco* states it.
    #
    # Derived rather than recalled: for each line, the cone tokens in its products'
    # descriptions were counted, and a token was kept when it appeared in at least half
    # of them. That threshold is what keeps incidental mentions out — "cone 5 oxidation"
    # turns up in 15 of 133 Stoneware descriptions as a photograph caption, not as a
    # firing claim, so Stoneware reads 6-10 rather than 5-10.
    #
    # The range lands on the *line*, not the glaze, because that is what the schema
    # models: `upsert_line` writes cone_from/cone_to and `inherit_line_cones` pushes them
    # down. A per-product range would be silent last-write-wins inside a line, since
    # upsert_line coalesces onto whatever the previous product wrote.
    "stoneware": ("6", "10"),
    "stoneware-specialty": ("6", "10"),
    "stoneware-clear": ("6", "10"),
    "stoneware-engobes": ("04", "10"),
    "stroke-coat": ("06", "10"),
    "speckled-stroke-coat": ("06", "10"),
    "foundations": ("06", "6"),
    "jungle-gems": ("06", "6"),
    "fundamentals-underglaze": ("06", "10"),
    "e-z-stroke-translucent-underglazes": ("06", "10"),
    "elements-and-elements-chunkies": ("06", "6"),
    "ritual-glazes": ("04", "10"),
    "designer-liner": ("06", "6"),
    "washes": ("06", "10"),
    "flux": ("6", "10"),
    "classic-crackles": ("06", "6"),
    "cobblestone": ("06", "10"),
    "snow-gems": ("06", "10"),
    "snowfall": ("06", "6"),
    "french-dimensions": ("06", "6"),
    "pottery-cascade": ("06", "6"),
    "rapid-roll": ("06", "06"),
    "low-fire-clear-glaze-brushing": ("06", "6"),
    "low-fire-clear-glaze-dipping": ("06", "6"),
}

CONE_UNSTATED: frozenset[str] = frozenset({"raku"})
"""Lines Mayco publishes no cone for at all. Raku is fired in a pit, so the omission is
the truth rather than a gap in our mapping.

These need their own set because `cone_range_for_category` cannot express the difference:
returning ``None`` is how a *miss* is signalled, and the loader files an
`unmapped_cone_category` issue for it. Filing six issues that say "we failed to map raku"
would be a lie about our own coverage, so the parser leaves `cone_category` unset for
these lines and nothing is reported."""


# --------------------------------------------------------------------------- attributes

BADGE_VALUES: dict[tuple[str, str], tuple[str, bool]] = {
    # (normalized attribute name, normalized value token) -> (GlazeBadges field, value).
    #
    # Mayco states the same fact three ways and the counts are not lopsided enough to
    # treat any of them as an edge case: an icon URL under /catalog/toxicology/ (338
    # products), plain prose (25), and once a raw `<img src=...>` tag. All three reduce to
    # the same token — the icon basename and the slugified prose coincide exactly, which
    # is why "Dinnerware Safe with Clear Glaze" and
    # `dinnerware-safe-with-clear-glaze.png` share one entry here.
    ("dinnerwaresafe", "dinnerware-safe"): ("dinnerware_safe", True),
    ("dinnerwaresafe", "not-dinnerware-safe"): ("dinnerware_safe", False),
    # Deliberately *not* dinnerware_safe=True. The claim is that the piece becomes safe
    # once a clear glaze covers it, which is precisely what food_safe_under_glaze means.
    # `dinnerware_safe` stays None because the page has not answered that question about
    # the glaze on its own.
    ("dinnerwaresafe", "dinnerware-safe-with-clear-glaze"): ("food_safe_under_glaze", True),
    ("foodsafe", "food-safe"): ("food_safe", True),
    # ACMI's seals certify *toxicity*, not food safety: AP is "Approved Product,
    # non-toxic", CL is "Cautionary Labelling required". Mapping either onto food_safe
    # would put a safety claim on 377 glazes that Mayco never made, and people decide
    # what to eat off using this chip. `ap_seal` is the field that means what they mean.
    ("foodsafe", "ap-acmi"): ("ap_seal", True),
    ("foodsafe", "cl-acmi"): ("ap_seal", False),
}

RECOGNIZED_NO_BADGE: frozenset[tuple[str, str]] = frozenset(
    {
        # A generic non-toxicity mark on one product. Recognized so it does not read as a
        # new unexplained icon, but it maps to no field we have: it is neither the ACMI AP
        # seal nor a food-safety claim.
        ("foodsafe", "non-toxic"),
    }
)

IGNORED_ATTRIBUTES: frozenset[str] = frozenset(
    {
        # Real attributes that carry nothing filterable. They must be listed rather than
        # left to fall through: unlisted names become `unknown_icons`, and these four
        # appear on nearly every product, so omitting them would file three parse issues
        # per glaze and drown the ones that matter.
        "countryoforigin",  # 650 products, always "US"
        "sizeunitofmeasure",  # 605 — jar sizes and their SKU variants
        "countsizeunitofmeasure",  # 9 — the same thing, spelled differently
        "navitemnumber",  # 19 — an internal navigation id
    }
)
"""Attribute names are compared with punctuation and case stripped, because Mayco spells
the same attribute both "Country Of Origin" and "Country of Origin"."""


# ------------------------------------------------------------------------ image grammar

FORM_KEYWORDS: dict[str, FormKind] = {
    "bowl": FormKind.BOWL,
    "bowls": FormKind.BOWL,
    "mug": FormKind.MUG,
    "cup": FormKind.CUP,
    "plate": FormKind.PLATE,
    "vase": FormKind.VASE,
    "tile": FormKind.FLAT_TILE,
    "tiles": FormKind.FLAT_TILE,
    "testtile": FormKind.FLAT_TILE,
}

NOISE_WORDS: frozenset[str] = frozenset(
    {
        # Publishing and cropping artefacts in Mayco's asset names. `web` alone appears
        # 593 times and `crop` 395; they say nothing about the glaze.
        "web", "crop", "cropped", "final", "copy", "edit", "edited", "new", "small",
        "large", "hires", "lores", "img", "image", "photo", "scaled", "labeled",
        "label", "release", "test", "igtall", "igsquare", "ig", "insta", "instagram",
        "sample", "swatch", "and", "the", "with", "on", "of", "in", "fired",
    }
)

LINE_IMAGE_WORDS: frozenset[str] = frozenset({"lineup"})
"""Words that mark an image as being about a whole line rather than one glaze.

`2024_SW_lineup_clay-body-bowls_1_IGtall.jpg` is shared by 11 Stoneware products and its
alt text describes the *clay* ("White Clay, cone 6 oxidation"), not a glaze — it is a row
of different glazes on one clay body. Attributing it to whichever product's page it was
found on would give eleven glazes the same hero colour and none of them their own.

Measured: 25 of 2680 distinct image basenames are shared by more than one product, so this
is a small class. It is also the only part of it a *per-image* rule can catch — the
grammar sees one filename at a time and cannot know that `MeltGloop-Test-tile_3.jpg` is on
nine pages. Catching the rest would need cross-product state the pure stage does not have."""

ATMOSPHERE_WORDS: frozenset[str] = frozenset({"oxidation", "reduction", "soda", "salt", "wood"})
"""Kiln atmosphere, which Mayco records and we have nowhere to put — `ImageFacts` has no
atmosphere field and `appearances` has no column. Named here so the grammar can report
them as unmatched tokens rather than swallowing them: `reduction` appears in 92 filenames
and `soda` in 48, so this is a real gap in the schema rather than a rounding error, and it
should surface in the parse-issue queue until there is somewhere for it to go."""

CLAY_BODIES: dict[str, tuple[str, str]] = {
    # code -> (name, color family), seeded by 20260905000100_mayco_clay_bodies.sql, which
    # supabase/tests/schema/contract.sql pins to exactly this list.
    #
    # Mayco names its clays rather than numbering them, and the clays are not Mayco's: the
    # 2026 release filenames spell out the bodies (`white_clay_standard_181`,
    # `speckled_clay_standard_212`, `red_clay_standard_308`, `brown_clay_standard_266`,
    # `white_wheat_clay_runyan_wheat`, `black_clay_si02_black_ice`). These codes are
    # Mayco's *labels* for those bodies, which is what its alt text and the app both use.
    #
    # Derived from a sweep of all 657 fired products (2985 images) on 2026-09-05. The same
    # five — white, speckled, red, dark brown, black — recur in four independent series
    # (2024 lineup bowls, 2025 release tiles, the clay-body-drips set, engobe comparisons).
    # `wheat` appears only in the 2026 release. `dark` is `_dark_clay_web` on 64 Stoneware
    # filenames with no alt text; it is not one of the six labels above and nothing says
    # whether it is Dark Brown or Black, so it is its own row rather than a guess. Merge
    # when evidence turns up, not before.
    "white": ("White Clay", "white"),
    "speckled": ("Speckled Clay", "speckled"),
    "red": ("Red Clay", "dark"),
    "dark-brown": ("Dark Brown Clay", "dark"),
    "black": ("Black Clay", "dark"),
    "wheat": ("Wheat Clay", "buff"),
    "dark": ("Dark Clay", "dark"),
}

CLAY_PHRASES: dict[str, str] = {
    # Words immediately before `clay`, in filenames and alt text -> code. Two merges, each
    # justified by a filename/alt pairing rather than by resemblance:
    # `speckled_clay_standard_212` carries alt "speckled brown clay" on all 8 images, and
    # `sw-166_brown_speckled_clay` is the same body spelled backwards; `brown_clay_standard_266`
    # carries alt "dark brown clay" on all 8, and the engobe series calls it "Dark Brown Clay".
    "white": "white",
    "speckled": "speckled",
    "speckled brown": "speckled",
    "brown speckled": "speckled",
    "red": "red",
    "dark brown": "dark-brown",
    "brown": "dark-brown",
    "black": "black",
    "wheat": "wheat",
    "white wheat": "wheat",
    "dark": "dark",
}
"""Not in this map, deliberately: "alternative clay bodies" (a tile of several clays),
"clay bodies test", "clay-body-drips" and "engobes-v-clay" — the word `clay` with no colour
before it says an image is *about* clay, not which one. The grammar leaves `clay` in
`unmatched_tokens` for those so a new label shows up rather than vanishing."""

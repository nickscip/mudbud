"""What Mayco encodes in an image's filename and alt text.

Mayco is unusual in a way that is worth stating, because it is the opposite of AMACO.
AMACO burns its captions into the pixels — which is why there is a composite splitter that
reads images at all — and leaves `alt` empty. Mayco writes real alt text
("1, 2, 3, 4 coats, cone 6 oxidation", "White Clay, cone 6 oxidation") *and* descriptive
filenames. Two independent text channels, no OCR.

Measured across the 2878 images of the 630 fired glazes:

* 2325 filenames contain their own product's code, so the subject is usually stated;
* `cone6` (785), `cone10` (809) and `cone5` (91) make cone the best-attested fact;
* `under` (186) is *more* common than `over` (119) — Mayco photographs a glaze beneath
  another as readily as on top of one, which AMACO never does;
* `1234coats` composites carry four regions, not AMACO's three.

The rule from the base class holds: nothing here guesses. An unresolved token lowers
confidence and is reported.
"""

from __future__ import annotations

import re
from itertools import pairwise
from pathlib import Path

from glaze_etl.core.models import Confidence, FormKind, ImageFacts, ImageRole
from glaze_etl.sources.mayco.vocabulary import (
    ATMOSPHERE_WORDS,
    CLAY_WORDS,
    FORM_KEYWORDS,
    LINE_IMAGE_WORDS,
    NOISE_WORDS,
)

_CODE_RE = re.compile(r"(?<![a-z0-9])([a-z]{1,3})-?(\d{1,4})(?![0-9])")
"""A glaze code as it appears in a filename. Mayco writes the same code both ways —
`sw214_...` and `sw-214_...` — so the separator is optional here and normalized away.

**One letter, not two.** 21 fired SKUs have a single-letter prefix — the whole `S-27xx` Jungle
Gems block, plus `C-300` — and requiring two silently classified every one of their swatches
as `OTHER` instead of `LABEL_CHIP`, because no code matched at all. Caught by
`data_quality.sql`'s "a high-confidence appearance must say something" assertion on the first
real load, which is the check earning its keep.

Widening is measured, not hopeful: across all 2878 corpus images it gains 43 matches against
real SKUs and adds **zero** new non-matching tokens. The lookbehind is what makes that safe —
a single letter only counts when nothing alphanumeric precedes it."""

_CONE_RE = re.compile(r"(?<![a-z0-9])cone[-_ ]?(0?\d{1,2})(?![0-9])")
_COATS_RE = re.compile(r"(?<![a-z0-9])(\d{1,4})[-_ ]?coats?(?![a-z])")
"""`1234coats` (four tiles in one image), `3coats`, `2_coats`."""

_DIRECTION_RE = re.compile(r"^[-_ ]*(over|under)[-_ ]*$")
"""What sits between two codes must be exactly `over` or `under` to establish an order.
`sw214_over_sw401_sw402` has three codes and therefore no single pair — recorded as a
combination rather than resolved into one that happens to read left to right."""

_SIZE_SUFFIX_RE = re.compile(r"-\d{2,4}x\d{2,4}$")
_SCALED_SUFFIX_RE = re.compile(r"-scaled$")
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
_BARE_NUMBER_RE = re.compile(r"^\d+[a-z]?$")


def normalize_code(prefix: str, digits: str) -> str:
    """`sw214` and `sw-214` both become `SW-214`.

    Mayco's own SKUs are inconsistent about the separator — 562 of 651 carry it, 89 do
    not, and `EZ112` sits beside `SW-214` — but no code exists in both spellings, so
    inserting the dash is a rename rather than a merge. Verified against the full catalog:
    630 products normalize to 630 distinct codes, no collisions.

    Zero padding is **kept**, unlike AMACO's `normalize_code`, which strips it. Mayco pads
    to three digits deliberately and consistently (`SW-001`, `PB-001`), so the padding is
    the manufacturer's spelling rather than an artefact of one URL form. Dropping it would
    invent a code Mayco never prints.

    Normalizing at all is what makes layering links resolvable: filenames disagree with
    their own SKU's separator 744 times out of 2368, and `link_layering` matches
    `glazes.code` exactly. Normalizing both sides lifts filename-to-catalog matches from
    1624 to 2401.
    """
    return f"{prefix.upper()}-{digits}"


def normalize_sku(sku: str) -> str:
    """Turn a Store API `sku` into the catalog's canonical code for this source.

    Also drops the trailing dedup suffix WooCommerce appends to a duplicated SKU —
    `SW-402-15649` is Dark Flux, not a product in a `-15649` line. A code with no digits
    at all (`PBDIP`, `NT-CLR`) has nothing to normalize and is uppercased as-is.
    """
    match = re.match(r"^([A-Za-z]+)-?(\d+)", sku.strip())
    if match is None:
        return sku.strip().upper()
    return normalize_code(match.group(1), match.group(2))


def _stem(filename: str) -> str:
    """Basename to a comparable stem: no extension, no WordPress size or scale suffix.

    Stripping happens here rather than on the URL. `-scaled` is the *real* file for images
    WordPress re-encoded above its 2560px threshold, so removing it from a URL would
    request bytes that do not exist; removing it from the stem only stops it reading as a
    token about the glaze.
    """
    stem = Path(filename).stem.lower()
    stem = _SIZE_SUFFIX_RE.sub("", stem)
    return _SCALED_SUFFIX_RE.sub("", stem)


_RECOGNIZED = NOISE_WORDS | LINE_IMAGE_WORDS | frozenset(FORM_KEYWORDS)
"""Every word some rule above already accounted for. Kept out of `unmatched_tokens`
because that field means "a rule failed here", and reporting a word the grammar read
correctly — `bowls`, which set the form; `lineup`, which set the role — would make the
review queue describe successes as gaps."""


def _tokens(stem: str, consumed: list[tuple[int, int]]) -> tuple[str, ...]:
    """Whatever the rules did not claim, as words worth reporting."""
    kept = []
    for index, char in enumerate(stem):
        kept.append(" " if any(start <= index < end for start, end in consumed) else char)
    return tuple(
        word
        for word in re.split(r"[^a-z0-9]+", "".join(kept))
        if word
        and len(word) > 1
        and word not in _RECOGNIZED
        and not _YEAR_RE.match(word)
        and not _BARE_NUMBER_RE.match(word)
    )


def interpret_filename(
    filename: str, product_code: str | None = None, alt: str | None = None
) -> ImageFacts:
    """Read every fact the filename and alt text state, and no more.

    ``alt`` is a second evidence channel rather than a fallback: Mayco's cone often appears
    in both, and its clay-body wording appears only in alt. It is consulted for cone when
    the filename is silent, and its words join `unmatched_tokens` so a fact stated only
    there is visible instead of lost.
    """
    stem = _stem(filename)
    consumed: list[tuple[int, int]] = []
    evidence: dict[str, str] = {}

    matches = list(_CODE_RE.finditer(stem))
    codes = [normalize_code(m.group(1), m.group(2)) for m in matches]
    consumed += [m.span() for m in matches]
    if codes:
        evidence["glaze_code"] = ",".join(codes)

    # --- layering, in whichever direction Mayco stated ------------------------------
    subject: str | None = None
    layered_over: str | None = None
    combination: tuple[str, ...] = ()
    if len(matches) == 2:
        # The cone is stripped out of the gap before it is tested, because Mayco sometimes
        # writes it between the two codes: `fd258_cone10_over_sw508`. Four filenames do
        # this, and demanding a bare `over` loses all four layering pairs to the
        # combination bucket. The cone is consumed by its own rule below either way.
        gap = _CONE_RE.sub("", stem[matches[0].end() : matches[1].start()])
        if direction := _DIRECTION_RE.match(gap):
            word = direction.group(1)
            consumed.append((matches[0].end(), matches[1].start()))
            # `under` inverts the pair. `sw214_under_sw401` is a photograph of SW-401 on
            # top of SW-214, so the subject is the *other* code. Recording it as
            # "SW-214 over SW-401" would invent a layering that does not exist, and
            # link_layering would write that inversion into the database.
            subject, layered_over = (
                (codes[0], codes[1]) if word == "over" else (codes[1], codes[0])
            )
            evidence["layering"] = f"{subject} over {layered_over}"
            evidence["layering_direction"] = word
    if layered_over is None and len(codes) > 1:
        # Several codes with no single pair to extract — `sw214_over_sw401_sw402` shows the
        # glaze over two different fluxes in one frame, which `layered_over_glaze_id`
        # cannot model. Recorded whole rather than narrowed to the first pair.
        combination = tuple(codes)
        for (start, end), gap in _gaps(stem, matches):
            if direction := _DIRECTION_RE.match(_CONE_RE.sub("", gap)):
                # Consumed even though it could not be acted on: the direction *was*
                # recognized, and leaving it to surface as an unmatched token would
                # report a rule failure on 98 products where the rule read the word fine
                # and the schema is what cannot hold three codes.
                consumed.append((start, end))
                evidence["layering_direction"] = direction.group(1)
                break

    if subject is None:
        subject = product_code if product_code in codes else (codes[0] if codes else product_code)

    # --- cone, from the filename first and the alt text second -----------------------
    cone: str | None = None
    if match := _CONE_RE.search(stem):
        cone = match.group(1)
        consumed.append(match.span())
        evidence["cone"] = match.group(0)
    elif alt and (match := _CONE_RE.search(alt.lower())):
        cone = match.group(1)
        evidence["cone_from_alt"] = match.group(0)

    # --- coats: recorded, never split ------------------------------------------------
    coats: str | None = None
    if match := _COATS_RE.search(stem):
        coats = match.group(1)
        consumed.append(match.span())
        # Not ImageRole.COATS_COMPOSITE, deliberately, and this is the F8 seam. Mayco's
        # composites hold four tiles (`1234coats`) captioned by brush-coat *count*, while
        # `CoatLevel` is AMACO's four thickness words and `coat_levels.ordinal` is a
        # global unique scale. Until F8 decides whether those are one axis, the image is
        # still a real appearance — it just is not split, and the count is kept here so
        # the decision has data when it is made.
        evidence["coats_unsplit"] = match.group(0)

    # --- form, and whether this depicts the line rather than the glaze ---------------
    form: FormKind | None = None
    line_image = False
    for word in re.split(r"[^a-z0-9]+", stem):
        if word in LINE_IMAGE_WORDS:
            line_image = True
            evidence["line_image"] = word
        if form is None and word in FORM_KEYWORDS:
            form = FORM_KEYWORDS[word]
            evidence["form"] = word

    unmatched = _tokens(stem, consumed)
    if alt:
        # Atmosphere and clay body are stated and have nowhere to go — see the notes on
        # ATMOSPHERE_WORDS and CLAY_WORDS. Surfacing them keeps the gap visible.
        alt_words = tuple(
            word
            for word in re.split(r"[^a-z0-9]+", alt.lower())
            if word in ATMOSPHERE_WORDS or word in CLAY_WORDS
        )
        unmatched = tuple(dict.fromkeys(unmatched + alt_words))

    role = (
        ImageRole.LINE_CHART
        if line_image
        else _role(codes, layered_over, combination, coats, form)
    )
    return ImageFacts(
        role=role,
        subject_code=subject,
        layered_over_code=layered_over,
        combination_codes=combination,
        cone=cone,
        form=form,
        confidence=_confidence(subject, codes, combination, unmatched),
        unmatched_tokens=unmatched,
        evidence=evidence,
    )


def _gaps(stem: str, matches: list[re.Match[str]]) -> list[tuple[tuple[int, int], str]]:
    """Each span between successive code matches, with the text it holds."""
    return [((a.end(), b.start()), stem[a.end() : b.start()]) for a, b in pairwise(matches)]


def _role(
    codes: list[str],
    layered_over: str | None,
    combination: tuple[str, ...],
    coats: str | None,
    form: FormKind | None,
) -> ImageRole:
    if layered_over is not None:
        return ImageRole.LAYERED
    if combination or coats:
        # Honest OTHER rather than a role that overstates. A four-thickness composite is
        # not "a single flat swatch", and colour-naming it as one would average four
        # coat thicknesses into a hero colour that matches none of them.
        return ImageRole.OTHER
    if form is not None and form is not FormKind.FLAT_TILE:
        return ImageRole.IN_USE
    if len(codes) == 1 or form is FormKind.FLAT_TILE:
        return ImageRole.LABEL_CHIP
    return ImageRole.OTHER


def _confidence(
    subject: str | None,
    codes: list[str],
    combination: tuple[str, ...],
    unmatched: tuple[str, ...],
) -> Confidence:
    """How much of this image's meaning the filename actually stated.

    `codes` is what makes the difference between HIGH and MEDIUM here, and it is not
    redundant with `subject`: `subject` falls back to the product whose page the image was
    found on, so a filename of pure noise — `web_crop.jpg` — still gets one. Reporting that
    as HIGH would claim the filename identified the glaze when it said nothing at all, and
    `data_quality.sql` trusts this field ("a high-confidence appearance must carry some
    condition"). So HIGH requires the code to have been *read*, not inherited.
    """
    if subject is None or combination:
        return Confidence.LOW
    if not codes:
        return Confidence.MEDIUM
    return Confidence.MEDIUM if unmatched else Confidence.HIGH

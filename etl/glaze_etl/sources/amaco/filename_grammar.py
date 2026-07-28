"""Reads the facts AMACO encodes into image filenames.

AMACO states almost nothing about an image in markup — alt text is just the product
name — but the CDN filenames are richly structured and have been for years:

    PC-20_6x6_Label_Tile_Chip-hires.jpg          a flat swatch of one glaze
    C-5_Charcoal_Cone5_Chip-HiRes.jpg            ... fired to cone 5
    PG-55overSM-11_Cone6.jpg                     PG-55 laid over SM-11 at cone 6
    PC-70_over_PCF-54_16M_Vase_Website.jpg       ... on White Chocolate No. 16 clay
    pc20-application-tiles-and-sake-cup.jpg      a 3-tile thickness composite
    gloss-glazes-color-chart-2048px.jpg          a whole-line chart

The rules below are deliberately conservative. Every one records what fired into
``evidence``; anything left over lands in ``unmatched_tokens`` and drags ``confidence``
down. Nothing is inferred to fill a gap — a low-confidence row is recoverable, a
confidently wrong one is not.
"""

from __future__ import annotations

import re
from pathlib import Path

from glaze_etl.core.models import Confidence, FormKind, ImageFacts, ImageRole
from glaze_etl.sources.amaco.vocabulary import (
    CLAY_BODIES,
    FLAT_SWATCH_WORDS,
    FORM_KEYWORDS,
    GLAZE_LINE_CODES,
    NOISE_WORDS,
)

_LINE_ALT = "|".join(code.lower() for code in GLAZE_LINE_CODES)

_CODE_RE = re.compile(rf"(?<![a-z0-9])({_LINE_ALT})[-_ ]?(\d{{1,3}})(?![0-9])")
"""Glaze SKU codes. The leading lookbehind is what stops `223lg` matching `lg`, and
GLAZE_LINE_CODES is ordered longest-first so `pcf-54` never parses as `pc` + stray `f`."""

_CONE_RE = re.compile(r"(?<![a-z0-9])cone[-_ ]?(0\d|\d{1,2})(?![0-9])")
_CLAY_RE = re.compile(r"(?<![a-z0-9])(\d{1,2})[-_ ]?m(?![a-z0-9])")
_APPLICATION_TILES_RE = re.compile(r"application[-_ ]?tiles?")
_COLOR_CHART_RE = re.compile(r"colou?r[-_ ]?chart")
_TILE_SIZE_RE = re.compile(r"(?<![a-z0-9])(\d{1,2})\s?x\s?(\d{1,2})(?![0-9x])")
_PIXEL_RE = re.compile(r"\d{3,4}\s?px(?:x\d{3,4}px)?", re.IGNORECASE)
_CACHE_BUSTER_RE = re.compile(r"__\d+\.\d+$")
_BARE_NUMBER_RE = re.compile(r"^\d+[a-z]?$")

_OVER_BETWEEN = re.compile(r"^[-_ ]*over[-_ ]*$")
"""Whatever sits between two codes must be exactly `over` to establish an order —
`PG-55overSM-11` and `CR-61_over_PC-16` qualify; `PG-42_V-392_PCF-54` does not."""


def normalize_code(line: str, number: str) -> str:
    """`c` + `05` -> `C-5`.

    Leading zeros are dropped so the slug form (`c-05-charcoal`) and the catalog form
    (`C-5 Charcoal`) collapse to one identity. Cone values are deliberately NOT
    normalized this way elsewhere: cone 05 and cone 5 are different temperatures.
    """
    return f"{line.upper()}-{int(number)}"


_GLUED_OVER_RE = re.compile(r"(?<=[a-z0-9])over(?=[a-z])")


def _strip_filename(filename: str) -> str:
    stem = Path(filename).stem
    stem = _CACHE_BUSTER_RE.sub("", stem)
    stem = stem.lower()
    # AMACO writes layering both ways: `CR-61_over_PC-16` and `PG-55overSM-11`. Prising
    # the glued form apart here means the code regex's word-boundary lookbehind sees
    # `sm-11` as a code rather than swallowing it inside `oversm`.
    return _GLUED_OVER_RE.sub("_over_", stem)


def _name_tokens(product_name: str | None) -> frozenset[str]:
    """Words from the product's own name, which carry no extra information.

    `C-5_Charcoal_Cone5_Chip` restates "Charcoal" from the title. Treating that as an
    unresolved token would penalise a filename we fully understood.
    """
    if not product_name:
        return frozenset()
    words = {w for w in re.split(r"[^a-z0-9]+", product_name.lower()) if len(w) > 1}
    # Filenames also glue the name together: "Fire & Ice" -> "FireAndIce".
    glued = "".join(sorted(words))
    return frozenset(words | {"".join(words), glued, "and"})


def _residual_tokens(
    stem: str, consumed: list[tuple[int, int]], name_words: frozenset[str]
) -> tuple[str, ...]:
    """Tokens no rule claimed, for confidence scoring and review."""
    chars = list(stem)
    for start, end in consumed:
        for i in range(start, end):
            chars[i] = " "
    leftover = _PIXEL_RE.sub(" ", "".join(chars))
    out: list[str] = []
    for raw in re.split(r"[-_ ]+", leftover):
        token = raw.strip()
        if not token or token in NOISE_WORDS or _BARE_NUMBER_RE.match(token):
            continue
        if token in name_words:
            continue
        # "FloatingLavendar" and "SpeckledYellow" are the product name run together;
        # recognise them by checking the token is built only from name words.
        if name_words and _is_concatenation_of(token, name_words):
            continue
        out.append(token)
    return tuple(out)


def _is_concatenation_of(token: str, words: frozenset[str]) -> bool:
    """True when `token` can be spelled by joining words from the product name."""
    if not token:
        return True
    return any(
        token.startswith(w) and _is_concatenation_of(token[len(w) :], words)
        for w in words
        if w and len(w) > 1
    )


def interpret_filename(
    filename: str, product_code: str | None = None, product_name: str | None = None
) -> ImageFacts:
    """Extract every fact the filename states. Never more than it states.

    ``product_code`` is the SKU of the page the image was found on. It decides which of
    several codes in a filename is the subject: on PCF-54's page,
    ``PC-70_over_PCF-54_16M_Vase`` is a picture of PC-70 *over* PCF-54, and both
    products legitimately show it.
    """
    stem = _strip_filename(filename)
    consumed: list[tuple[int, int]] = []
    evidence: dict[str, str] = {}

    code_matches = list(_CODE_RE.finditer(stem))
    codes = [normalize_code(m.group(1), m.group(2)) for m in code_matches]
    consumed += [m.span() for m in code_matches]
    if codes:
        evidence["glaze_code"] = ",".join(codes)

    # --- layering: `over` sitting between two codes, in that order ----------------
    top_code: str | None = None
    base_code: str | None = None
    for i in range(len(code_matches) - 1):
        gap = stem[code_matches[i].end() : code_matches[i + 1].start()]
        if _OVER_BETWEEN.match(gap):
            top_code, base_code = codes[i], codes[i + 1]
            consumed.append((code_matches[i].end(), code_matches[i + 1].start()))
            evidence["layering"] = f"{top_code} over {base_code}"
            break

    # --- cone ----------------------------------------------------------------------
    cone: str | None = None
    if m := _CONE_RE.search(stem):
        cone = m.group(1)
        consumed.append(m.span())
        evidence["cone"] = m.group(0)

    # --- clay body, checked against the clays AMACO actually sells -----------------
    clay_body: int | None = None
    for m in _CLAY_RE.finditer(stem):
        candidate = int(m.group(1))
        if candidate in CLAY_BODIES:
            clay_body = candidate
            consumed.append(m.span())
            evidence["clay_body"] = m.group(0)
            break

    # --- composite / chart ----------------------------------------------------------
    is_coats_composite = False
    if m := _APPLICATION_TILES_RE.search(stem):
        is_coats_composite = True
        consumed.append(m.span())
        evidence["coats_composite"] = m.group(0)

    is_line_chart = False
    if m := _COLOR_CHART_RE.search(stem):
        is_line_chart = True
        consumed.append(m.span())
        evidence["line_chart"] = m.group(0)

    # --- tile size ------------------------------------------------------------------
    tile_size: str | None = None
    if m := _TILE_SIZE_RE.search(stem):
        tile_size = f"{m.group(1)}x{m.group(2)}"
        consumed.append(m.span())
        evidence["tile_size"] = tile_size

    # --- form -------------------------------------------------------------------------
    form: FormKind | None = None
    swatch_word_seen = False
    for word, kind in FORM_KEYWORDS.items():
        for m in re.finditer(rf"(?<![a-z]){re.escape(word)}(?![a-z])", stem):
            consumed.append(m.span())
            if word in FLAT_SWATCH_WORDS:
                swatch_word_seen = True
            # A vessel beats a tile: "application-tiles-and-sake-cup" is still a
            # composite, but "SH-22_Acai_Matte_Bowl" is a picture of a bowl.
            if form is None or (form in (FormKind.FLAT_TILE, FormKind.TEXTURED_TILE)):
                form = kind
    if form is not None:
        evidence["form"] = form.value

    # --- role ---------------------------------------------------------------------------
    if is_line_chart:
        role = ImageRole.LINE_CHART
    elif is_coats_composite:
        role = ImageRole.COATS_COMPOSITE
    elif top_code is not None:
        role = ImageRole.LAYERED
    elif form is not None and form not in (FormKind.FLAT_TILE, FormKind.TEXTURED_TILE):
        role = ImageRole.IN_USE
    elif swatch_word_seen:
        role = ImageRole.LABEL_CHIP
    elif len(codes) == 1:
        # A lone code with no other signal is AMACO's plain product swatch.
        role = ImageRole.LABEL_CHIP
    else:
        role = ImageRole.OTHER

    # --- subject ------------------------------------------------------------------------
    subject: str | None
    if role is ImageRole.LINE_CHART:
        # A whole-line chart depicts every glaze in the line, so it is not a picture
        # "of" the product whose page it happens to hang on.
        subject = None
    elif top_code is not None:
        subject = top_code
    elif product_code and product_code in codes:
        subject = product_code
    elif len(codes) == 1:
        subject = codes[0]
    else:
        subject = product_code if product_code else None

    combination: tuple[str, ...] = ()
    if top_code is None and len(codes) > 1:
        # Several glazes named with nothing to order them. Recorded as an unordered
        # set rather than guessed into a layering pair.
        combination = tuple(codes)

    unmatched = _residual_tokens(stem, consumed, _name_tokens(product_name))

    if subject is None or combination:
        confidence = Confidence.LOW
    elif not codes:
        # The filename named no glaze at all — the subject is only an assumption from
        # which page we found it on. `37418X.jpg` teaches us nothing.
        confidence = Confidence.LOW
    elif unmatched:
        confidence = Confidence.MEDIUM
    else:
        confidence = Confidence.HIGH

    return ImageFacts(
        role=role,
        subject_code=subject,
        layered_over_code=base_code,
        combination_codes=combination,
        cone=cone,
        clay_body_number=clay_body,
        form=form,
        tile_size=tile_size,
        # Credit is deliberately not read from filenames. `Blick` (a retailer),
        # `Medina`, `JenH` and `Jensen` are structurally identical leftovers, so a
        # heuristic would mislabel a store as an artist. They stay in
        # unmatched_tokens; the real credit is burned into the image caption.
        credit=None,
        confidence=confidence,
        unmatched_tokens=unmatched,
        evidence=evidence,
    )

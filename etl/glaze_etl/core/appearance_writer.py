"""Turns one image's payload into appearance rows.

Separate from the rest of the loader because this is the only part carrying domain rules
rather than upserts: which images count as evidence, how a resolved composite fans out
into one row per coat thickness, and what must survive a text-only reparse. Those rules
change when the appearance model changes; the product and image upserts change when the
catalog schema does.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Protocol

import psycopg
from psycopg.types.json import Json

from glaze_etl.core.models import CoatLevel, ImageFacts, ImageRole
from glaze_etl.core.normalizer import Normalizer, Resolution
from glaze_etl.core.payloads import ImagePayload, RegionPayload


class IssueRecorder(Protocol):
    """Files a review item. Supplied by the caller so this module never owns the queue."""

    def __call__(
        self, manufacturer: str, kind: str, subject: str, detail: dict[str, object]
    ) -> None: ...


def _as_bbox(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    return {str(k): int(v) for k, v in value.items() if isinstance(v, int | float)}


def _as_lab(*values: object) -> tuple[float, float, float] | None:
    if any(v is None for v in values):
        return None
    numbers = [float(v) for v in values if isinstance(v, int | float)]
    return (numbers[0], numbers[1], numbers[2]) if len(numbers) == 3 else None


@dataclass(frozen=True)
class _CarriedColour:
    """A non-composite appearance's measured colour, read back for a text-only reparse."""

    hex_dominant: str | None
    hex_secondary: str | None
    lab: tuple[float, float, float] | None
    lab_secondary: tuple[float, float, float] | None


class AppearanceWriter:
    def __init__(
        self,
        conn: psycopg.Connection[tuple[object, ...]],
        normalizer: Normalizer,
        record_issue: IssueRecorder,
    ) -> None:
        self._conn = conn
        self._normalizer = normalizer
        self._record_issue = record_issue

    def existing_pixel_data(self, image_id: int) -> tuple[RegionPayload, ...]:
        """Coat regions already recorded for this image, with their measured colours.

        Exists so a text-only reparse does not destroy pixel-derived data. Appearances mix two
        sources: the filename grammar supplies cone, clay body, form and layering, while
        splitting the image supplies coat thickness, crop boxes and colour. Since `replace`
        rewrites a whole row set, running without image processing silently collapsed 44
        three-region composites into 44 single rows — observed twice, appearances dropping
        1325 -> 1237 both times.

        This only covers split composite regions — rows with a `crop_bbox`, joined through
        `coat_levels` for their thickness. An ordinary, single-swatch appearance has neither,
        so it is never returned here; `existing_singleton_colour` is the other half that
        carries *that* row's colour forward.

        F8b seam: `CoatLevel(str(key))` below is AMACO's four thickness words, so this
        method cannot read back a Mayco row keyed '1'-'4'. Unreachable today — Mayco's
        `coat_order` is empty, so it stores no regions to read back — and the second place
        that has to widen when the splitter learns four tiles, after the enum itself.
        """
        rows = self._conn.execute(
            """
            select cl.key, a.crop_bbox, a.hex, a.hex2,
                   a.lab_l, a.lab_a, a.lab_b, a.lab2_l, a.lab2_a, a.lab2_b
            from appearances a
            join coat_levels cl on cl.id = a.coat_level_id
            where a.image_id = %s and a.crop_bbox is not null
            order by cl.ordinal
            """,
            (image_id,),
        ).fetchall()
        out: list[RegionPayload] = []
        for row in rows:
            key, bbox, hex1, hex2 = row[0], row[1], row[2], row[3]
            out.append(
                RegionPayload(
                    coat_level=CoatLevel(str(key)),
                    crop_bbox=_as_bbox(bbox),
                    hex_dominant=str(hex1) if hex1 else None,
                    hex_secondary=str(hex2) if hex2 else None,
                    lab=_as_lab(row[4], row[5], row[6]),
                    lab_secondary=_as_lab(row[7], row[8], row[9]),
                )
            )
        return tuple(out)

    def existing_singleton_colour(self, image_id: int) -> _CarriedColour | None:
        """The whole-image row's measured colour already recorded for this image, if any.

        Complements `existing_pixel_data` for the live ordinary-image path: an ordinary
        appearance has no `crop_bbox` and no `coat_level_id`, so it never joins through
        `coat_levels` and was never carried forward by that method (roadmap E6). A
        schema-permitted composite row with a crop box but no resolved coat level remains
        outside both readers; `normalizer_for` prevents that state in the live pipeline.

        Fetches up to two rows rather than one. Nothing at the schema level stops a second
        `crop_bbox is null` row existing for one image, and silently picking one with
        `limit 1` would make a reparse arbitrarily discard the other. No current write path
        produces that state, so this raises loudly instead of guessing which row is right,
        the same way the manufacturer mismatch check above already does.
        """
        rows = self._conn.execute(
            """
            select hex, hex2, lab_l, lab_a, lab_b, lab2_l, lab2_a, lab2_b
            from appearances
            where image_id = %s and crop_bbox is null
            limit 2
            """,
            (image_id,),
        ).fetchall()
        if not rows:
            return None
        if len(rows) > 1:
            raise ValueError(
                f"image {image_id} has more than one non-composite appearance row; "
                "expected at most one, so a text-only reparse cannot tell which one to "
                "carry forward"
            )
        row = rows[0]
        hex1, hex2 = row[0], row[1]
        return _CarriedColour(
            hex_dominant=str(hex1) if hex1 else None,
            hex_secondary=str(hex2) if hex2 else None,
            lab=_as_lab(row[2], row[3], row[4]),
            lab_secondary=_as_lab(row[5], row[6], row[7]),
        )

    def replace(
        self, glaze_id: int, image_id: int, payload: ImagePayload, *, manufacturer: str
    ) -> int:
        """Rewrite this image's appearances, returning how many rows were written.

        Delete-then-insert rather than upsert: an appearance has no natural key, and a
        grammar improvement can legitimately change how many rows one image yields.

        ``manufacturer`` is who any unresolved-token issues are filed against; the
        payload is per-image and carries no product context of its own.
        """
        if manufacturer != self._normalizer.manufacturer.value:
            # The vocabulary is scoped to one brand (F8), so a normalizer built for another
            # would resolve this product's cone and clay against the wrong rows — or, worse,
            # against rows that merely share a key. Nothing upstream pairs them wrongly
            # today; this is what stops a future call site from being the first.
            raise ValueError(
                f"normalizer resolves {self._normalizer.manufacturer.value!r} but this "
                f"product is {manufacturer!r}"
            )

        if not payload.regions and payload.lab is None:
            # No pixels were processed this run, so anything the pixels produced must be
            # carried over rather than dropped.
            carried = self.existing_pixel_data(image_id)
            if carried:
                payload = replace(payload, regions=carried)
            else:
                # Not a composite — the ordinary, single-swatch case E6 was about. Carry
                # that row's own colour forward instead of leaving it null.
                singleton = self.existing_singleton_colour(image_id)
                if singleton is not None:
                    payload = replace(
                        payload,
                        hex_dominant=singleton.hex_dominant,
                        hex_secondary=singleton.hex_secondary,
                        lab=singleton.lab,
                        lab_secondary=singleton.lab_secondary,
                    )

        self._conn.execute("delete from appearances where image_id = %s", (image_id,))

        facts = payload.facts
        if facts.role is ImageRole.LINE_CHART:
            # A whole-line chart depicts every glaze in the line, so it is not evidence
            # about any single one.
            return 0

        resolved = self._normalizer.resolve_appearance(
            cone=facts.cone,
            clay_body_code=facts.clay_body_code,
            form=facts.form,
            coat_level=facts.coat_level,
        )
        for kind, value in resolved.unresolved:
            self._record_issue(manufacturer, kind, payload.raw_filename, {"value": value})

        if payload.regions:
            # A resolved composite yields one row per thickness. This is the coat axis the
            # feature is built around, and the only place it comes from.
            for region in payload.regions:
                coat_level_id = self._normalizer.coat_level_id(region.coat_level)
                if coat_level_id is None:
                    # The whole-image path reports an unresolved level through
                    # `resolve_appearance`; this one used to swallow it, writing a null at
                    # an unchanged row count — the coat axis silently absent from exactly
                    # the images that exist to document it.
                    self._record_issue(
                        manufacturer,
                        "unknown_coat_level",
                        payload.raw_filename,
                        {"value": region.coat_level.value},
                    )
                self._insert(
                    glaze_id,
                    image_id,
                    resolved,
                    facts,
                    hex_dominant=region.hex_dominant,
                    hex_secondary=region.hex_secondary,
                    lab=region.lab,
                    lab_secondary=region.lab_secondary,
                    coat_level_id=coat_level_id,
                    crop_bbox=region.crop_bbox,
                )
            return len(payload.regions)

        self._insert(
            glaze_id,
            image_id,
            resolved,
            facts,
            hex_dominant=payload.hex_dominant,
            hex_secondary=payload.hex_secondary,
            lab=payload.lab,
            lab_secondary=payload.lab_secondary,
            coat_level_id=resolved.coat_level_id,
            crop_bbox=None,
        )
        return 1

    def _insert(
        self,
        glaze_id: int,
        image_id: int,
        resolved: Resolution,
        facts: ImageFacts,
        *,
        hex_dominant: str | None,
        hex_secondary: str | None,
        lab: tuple[float, float, float] | None,
        lab_secondary: tuple[float, float, float] | None,
        coat_level_id: int | None,
        crop_bbox: dict[str, int] | None,
    ) -> None:
        lab_values = lab or (None, None, None)
        lab2 = lab_secondary or (None, None, None)

        self._conn.execute(
            """
            insert into appearances (
              glaze_id, image_id, crop_bbox, cone_id, coat_level_id, clay_body_id, form_id,
              lab_l, lab_a, lab_b, lab2_l, lab2_a, lab2_b, hex, hex2,
              source, confidence, evidence
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                      'manufacturer', %s, %s)
            """,
            (
                glaze_id,
                image_id,
                Json(crop_bbox) if crop_bbox else None,
                resolved.cone_id,
                coat_level_id,
                resolved.clay_body_id,
                resolved.form_id,
                *lab_values,
                *lab2,
                hex_dominant,
                hex_secondary,
                facts.confidence.value,
                Json(
                    {**facts.evidence, "layered_over_code": facts.layered_over_code or ""}
                ),
            ),
        )

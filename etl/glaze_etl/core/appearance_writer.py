"""Turns one image's payload into appearance rows.

Separate from the rest of the loader because this is the only part carrying domain rules
rather than upserts: which images count as evidence, how a resolved composite fans out
into one row per coat thickness, and what must survive a text-only reparse. Those rules
change when the appearance model changes; the product and image upserts change when the
catalog schema does.
"""

from __future__ import annotations

from dataclasses import replace
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

        Carrying the pixel side forward means `reparse` updates exactly what it re-derived.
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

    def replace(self, glaze_id: int, image_id: int, payload: ImagePayload) -> int:
        """Rewrite this image's appearances, returning how many rows were written.

        Delete-then-insert rather than upsert: an appearance has no natural key, and a
        grammar improvement can legitimately change how many rows one image yields.
        """
        if not payload.regions and payload.lab is None:
            # No pixels were processed this run, so anything the pixels produced must be
            # carried over rather than dropped.
            carried = self.existing_pixel_data(image_id)
            if carried:
                payload = replace(payload, regions=carried)

        self._conn.execute("delete from appearances where image_id = %s", (image_id,))

        facts = payload.facts
        if facts.role is ImageRole.LINE_CHART:
            # A whole-line chart depicts every glaze in the line, so it is not evidence
            # about any single one.
            return 0

        resolved = self._normalizer.resolve_appearance(
            cone=facts.cone,
            clay_body_number=facts.clay_body_number,
            form=facts.form,
            coat_level=facts.coat_level,
        )
        for kind, value in resolved.unresolved:
            self._record_issue("amaco", kind, payload.raw_filename, {"value": value})

        if payload.regions:
            # A resolved composite yields one row per thickness. This is the coat axis the
            # feature is built around, and the only place it comes from.
            for region in payload.regions:
                self._insert(
                    glaze_id,
                    image_id,
                    resolved,
                    facts,
                    hex_dominant=region.hex_dominant,
                    hex_secondary=region.hex_secondary,
                    lab=region.lab,
                    lab_secondary=region.lab_secondary,
                    coat_level_id=self._normalizer.coat_level_id(region.coat_level),
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

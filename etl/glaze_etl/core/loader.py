"""Writes parsed products, their images, and their appearances into Postgres.

Idempotent by construction: every crawl re-runs the same upserts, so a product that has
not changed produces no new rows and no duplicates. That matters because the crawl is
scheduled — a weekly run that grew the tables every time would be unusable.

Layering is resolved in a second pass. `PG-55overSM-11` names SM-11 as the base, but
SM-11 may not be loaded yet when PG-55 is written, so the code is stored on the row and
linked once every product exists. Running it as a separate step also means a base glaze
that AMACO has withdrawn simply leaves the link null instead of failing the load.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import psycopg
import structlog
from psycopg.types.json import Json

from glaze_etl.core.models import CoatLevel, ImageFacts, ImageRole, ParsedProduct
from glaze_etl.core.normalizer import Normalizer, Resolution
from glaze_etl.sources.amaco.vocabulary import CATEGORY_CONE_RANGE

log = structlog.get_logger(__name__)


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


@dataclass
class LoadStats:
    glazes: int = 0
    images: int = 0
    appearances: int = 0
    issues: int = 0
    layer_links: int = 0


def _as_bbox(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    return {str(k): int(v) for k, v in value.items() if isinstance(v, int | float)}


def _as_lab(*values: object) -> tuple[float, float, float] | None:
    if any(v is None for v in values):
        return None
    numbers = [float(v) for v in values if isinstance(v, int | float)]
    return (numbers[0], numbers[1], numbers[2]) if len(numbers) == 3 else None


def _row_id(row: tuple[object, ...] | None) -> int:
    """Pull a RETURNING id out of a psycopg row with the type narrowed."""
    assert row is not None, "expected a RETURNING row"
    value = row[0]
    assert isinstance(value, int)
    return value


class Loader:
    def __init__(
        self, conn: psycopg.Connection[tuple[object, ...]], normalizer: Normalizer
    ) -> None:
        self._conn = conn
        self._normalizer = normalizer
        self.stats = LoadStats()

    # ------------------------------------------------------------------ lines
    def upsert_line(self, product: ParsedProduct) -> int | None:
        if not product.line_code:
            return None

        cone_range = CATEGORY_CONE_RANGE.get(product.cone_category or "")
        if cone_range is None and product.cone_category:
            # Better to leave the range null and say so than to guess endpoints. A null
            # range matches every cone query, so the glaze stays findable meanwhile.
            self.record_issue(
                product.manufacturer.value,
                "unmapped_cone_category",
                product.line_code,
                {"category": product.cone_category},
            )
        cone_from = self._normalizer.cone_id(cone_range[0]) if cone_range else None
        cone_to = self._normalizer.cone_id(cone_range[1]) if cone_range else None

        row = self._conn.execute(
            """
            insert into glaze_lines (manufacturer_id, code, name, cone_from_id, cone_to_id)
            select m.id, %s, %s, %s, %s from manufacturers m where m.key = %s
            on conflict (manufacturer_id, code) do update set
              name = excluded.name,
              cone_from_id = coalesce(excluded.cone_from_id, glaze_lines.cone_from_id),
              cone_to_id = coalesce(excluded.cone_to_id, glaze_lines.cone_to_id)
            returning id
            """,
            (
                product.line_code,
                product.line_name or product.line_code,
                cone_from,
                cone_to,
                product.manufacturer.value,
            ),
        ).fetchone()
        return _row_id(row) if row else None

    # ----------------------------------------------------------------- glazes
    def upsert_glaze(self, product: ParsedProduct, line_id: int | None) -> int:
        badges = product.badges
        resolved = self._normalizer.resolve_glaze(
            surface=badges.surface, opacity=badges.opacity
        )
        for kind, value in resolved.unresolved:
            self.record_issue(product.manufacturer.value, kind, product.code, {"value": value})

        row = self._conn.execute(
            """
            insert into glazes (
              manufacturer_id, line_id, code, name, slug, product_url, description,
              surface_id, opacity_id,
              food_safe, food_safe_under_glaze, food_safe_not_durable, astm_d4236,
              dinnerware_safe, lead_free, ap_seal,
              spray_safe, mixable, layerable, prop65, is_dipping,
              price_min, price_max, availability, source_content_hash, last_seen_at
            )
            select m.id, %s, %s, %s, %s, %s, %s, %s, %s,
                   %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                   %s, %s, %s, %s, now()
            from manufacturers m where m.key = %s
            on conflict (manufacturer_id, code) do update set
              line_id = excluded.line_id,
              name = excluded.name,
              description = excluded.description,
              surface_id = excluded.surface_id,
              opacity_id = excluded.opacity_id,
              food_safe = excluded.food_safe,
              food_safe_under_glaze = excluded.food_safe_under_glaze,
              food_safe_not_durable = excluded.food_safe_not_durable,
              astm_d4236 = excluded.astm_d4236,
              ap_seal = excluded.ap_seal,
              spray_safe = excluded.spray_safe,
              mixable = excluded.mixable,
              layerable = excluded.layerable,
              prop65 = excluded.prop65,
              is_dipping = excluded.is_dipping,
              price_min = excluded.price_min,
              price_max = excluded.price_max,
              availability = excluded.availability,
              source_content_hash = excluded.source_content_hash,
              last_seen_at = now()
            returning id
            """,
            (
                line_id,
                product.code,
                product.name,
                product.external_id,
                str(product.product_url),
                product.description,
                resolved.surface_id,
                resolved.opacity_id,
                badges.food_safe,
                badges.food_safe_under_glaze,
                badges.food_safe_not_durable,
                badges.astm_d4236,
                badges.dinnerware_safe,
                badges.lead_free,
                badges.ap_seal,
                badges.spray_safe,
                badges.mixable,
                badges.layerable,
                badges.prop65,
                badges.is_dipping,
                product.price_min,
                product.price_max,
                product.availability,
                None,
                product.manufacturer.value,
            ),
        ).fetchone()
        self.stats.glazes += 1
        return _row_id(row)

    def inherit_line_cones(self) -> int:
        """Give every glaze a cone range, falling back to its line's.

        Most SKUs state cone only in a breadcrumb or in prose, so without this the cone
        filter runs against nulls and the feature silently returns nothing.
        `cone_source` keeps the distinction auditable rather than presenting a guess as
        a measurement.
        """
        cursor = self._conn.execute(
            """
            update glazes g set
              cone_from_id = l.cone_from_id,
              cone_to_id = l.cone_to_id,
              cone_source = 'line'
            from glaze_lines l
            where g.line_id = l.id
              and g.cone_from_id is null
              and l.cone_from_id is not null
            """
        )
        return cursor.rowcount

    def known_sha256(self, source_url: str) -> str | None:
        """The content hash already recorded for this URL, if any.

        Breaks the chicken-and-egg in MediaProcessor: the blob key is the content hash, so
        without this it must download an image to discover whether it already has it.
        """
        row = self._conn.execute(
            "select sha256 from glaze_images where source_url = %s and sha256 is not null "
            "limit 1",
            (source_url,),
        ).fetchone()
        if row is None:
            return None
        value = row[0]
        return str(value) if value else None

    # ----------------------------------------------------------------- images
    def upsert_image(self, glaze_id: int, payload: ImagePayload) -> int:
        facts = payload.facts
        row = self._conn.execute(
            """
            insert into glaze_images (
              glaze_id, source_url, storage_path, sha256, width, height,
              role, raw_filename, parse_confidence, evidence
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (glaze_id, source_url) do update set
              storage_path = excluded.storage_path,
              sha256 = excluded.sha256,
              width = excluded.width,
              height = excluded.height,
              role = excluded.role,
              parse_confidence = excluded.parse_confidence,
              evidence = excluded.evidence
            returning id
            """,
            (
                glaze_id,
                payload.source_url,
                payload.storage_path,
                payload.sha256,
                payload.width,
                payload.height,
                facts.role.value,
                payload.raw_filename,
                facts.confidence.value,
                Json(facts.evidence),
            ),
        ).fetchone()
        self.stats.images += 1
        return _row_id(row)

    # ------------------------------------------------------------ appearances
    def existing_pixel_data(self, image_id: int) -> tuple[RegionPayload, ...]:
        """Coat regions already recorded for this image, with their measured colours.

        Exists so a text-only reparse does not destroy pixel-derived data. Appearances mix two
        sources: the filename grammar supplies cone, clay body, form and layering, while
        splitting the image supplies coat thickness, crop boxes and colour. Since
        replace_appearances rewrites a whole row set, running without image processing silently
        collapsed 44 three-region composites into 44 single rows — observed twice, appearances
        dropping 1325 -> 1237 both times.

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

    def replace_appearances(self, glaze_id: int, image_id: int, payload: ImagePayload) -> int:
        """Rewrite this image's appearances.

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
            self.record_issue("amaco", kind, payload.raw_filename, {"value": value})

        if payload.regions:
            # A resolved composite yields one row per thickness. This is the coat axis the
            # feature is built around, and the only place it comes from.
            for region in payload.regions:
                self._insert_appearance(
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
            self.stats.appearances += len(payload.regions)
            return len(payload.regions)

        self._insert_appearance(
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
        self.stats.appearances += 1
        return 1

    def _insert_appearance(
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

    def link_layering(self) -> int:
        """Second pass: turn stored `layered_over_code` values into glaze ids.

        Deliberately separate from the main load, because the base glaze may be crawled
        after the image that references it, and a withdrawn base should leave the link
        null rather than fail the load.
        """
        cursor = self._conn.execute(
            """
            update appearances a
            set layered_over_glaze_id = base.id
            from glazes base, glazes subject
            where a.glaze_id = subject.id
              and base.manufacturer_id = subject.manufacturer_id
              and base.code = a.evidence->>'layered_over_code'
              and a.layered_over_glaze_id is null
              and coalesce(a.evidence->>'layered_over_code', '') <> ''
            """
        )
        self.stats.layer_links += cursor.rowcount
        return cursor.rowcount

    def refresh_color_terms(self, glaze_id: int, terms: list[str]) -> None:
        """Write the words ColorNamer derived, which is what makes colour search work."""
        self._conn.execute(
            "update glazes set color_terms = %s where id = %s",
            (sorted(set(terms)), glaze_id),
        )

    # ----------------------------------------------------------------- issues
    def record_issue(
        self, manufacturer: str, kind: str, subject: str, detail: dict[str, object]
    ) -> None:
        """File a review item, once per (kind, subject) while it stays unresolved.

        Deduped because the crawl is scheduled: without it every weekly run re-filed the same
        findings and the queue grew without bound, making its size meaningless. Observed as 32
        `composite_unsplit` rows for 16 composites after two loads.

        Detail is refreshed on an existing row rather than ignored, so the newest reason wins —
        a refusal reason can change as the code changes.
        """
        self._conn.execute(
            """
            with m as (select id from manufacturers where key = %(manufacturer)s),
            existing as (
              update parse_issues set detail = %(detail)s
              where kind = %(kind)s and subject = %(subject)s and resolved_at is null
              returning id
            )
            insert into parse_issues (manufacturer_id, kind, subject, detail)
            select m.id, %(kind)s, %(subject)s, %(detail)s from m
            where not exists (select 1 from existing)
            """,
            {
                "manufacturer": manufacturer,
                "kind": kind,
                "subject": subject,
                "detail": Json(detail),
            },
        )
        self.stats.issues += 1

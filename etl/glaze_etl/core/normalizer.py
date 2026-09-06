"""Maps scraped values onto the seeded vocabularies' primary keys.

This is the layer that refuses to invent things. The grammar yields human-facing values —
clay code `"16"` or `"white"`, cone name `"05"`, opacity `"opaque"` — while every column in
`appearances` is a foreign key. Resolving one to the other is the last chance to notice
that a value is not in our vocabulary, and the rule is that an unknown value becomes a
reported issue rather than a null that looks like "not stated".

Three subtleties worth stating outright:

* **Cone names are not numbers.** `05` is far cooler than `5`, so they are matched as
  text against `cones.name` and never cast. The seeded ids are ordered by temperature,
  which is what makes range queries integer arithmetic later.
* **Layering needs two passes.** `PG-55overSM-11` cannot resolve SM-11 to a glaze id
  while SM-11 may not be loaded yet, so the Loader records the code and links it after
  every product exists.
* **Two of the vocabularies belong to a manufacturer, not to the catalog** (F8/F8a).
  `clay_bodies` and `coat_levels` carry a `manufacturer_id`, so a lookup that ignores it
  resolves a key to whichever brand's row happened to load. That was harmless only while
  the seeded key sets were disjoint — AMACO's thickness words against Mayco's brush-coat
  digits — which is an accident of the data rather than a property of the code. So the
  whole `Vocabularies` object now belongs to one manufacturer, and a `Normalizer` built
  from it cannot reach another brand's rows at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from glaze_etl.core.models import CoatLevel, FormKind, ManufacturerKey, Opacity, Surface


@dataclass(frozen=True)
class Vocabularies:
    """Lookup ids, read once per run from the database, for one manufacturer."""

    manufacturer: ManufacturerKey
    """Whose vocabulary this is. The scoped tables below hold only this brand's rows, and
    it is what lets a writer assert that the product it is loading agrees."""
    cones: dict[str, int]
    """Cone *name* to id: {"05": 18, "5": 27, "6": 28}. Not manufacturer-scoped — a cone
    is a firing temperature, not a brand's word for one."""
    clay_bodies: dict[str, int]
    """This manufacturer's clay code to id: {"16": 2, "32": 5} for AMACO,
    {"white": 10, "dark-brown": 12} for Mayco. Codes are the brand's own spelling."""
    surfaces: dict[str, int]
    opacities: dict[str, int]
    forms: dict[str, int]
    coat_levels: dict[str, int]
    """This manufacturer's application-level key to id. AMACO's thickness words; Mayco's
    brush-coat counts, which are seeded but unreachable until F8b gives it a splitter."""
    manufacturers: dict[str, int]
    """Every manufacturer key to id — deliberately not scoped, since this *is* the map
    the scoping is done through."""


@dataclass
class Resolution:
    """The resolved ids, plus whatever could not be resolved.

    `unresolved` is deliberately not an exception: one unmappable form should not lose
    an otherwise good appearance row. It becomes a parse_issue instead.
    """

    cone_id: int | None = None
    clay_body_id: int | None = None
    surface_id: int | None = None
    opacity_id: int | None = None
    form_id: int | None = None
    coat_level_id: int | None = None
    unresolved: list[tuple[str, str]] = field(default_factory=list)

    def note(self, kind: str, value: str) -> None:
        self.unresolved.append((kind, value))


class Normalizer:
    def __init__(self, vocabularies: Vocabularies) -> None:
        self._vocab = vocabularies

    @property
    def manufacturer(self) -> ManufacturerKey:
        """Whose vocabulary this resolves against. Exposed so a caller holding both a
        product and a normalizer can assert they agree rather than assume it."""
        return self._vocab.manufacturer

    def missing_coat_levels(self, keys: tuple[CoatLevel, ...]) -> tuple[CoatLevel, ...]:
        """Which of `keys` this manufacturer does not publish.

        For the one caller that matters, `SourceAdapter.coat_order`, checked once at
        startup. The region path in `AppearanceWriter` resolves a coat level through a
        plain dict lookup, so a vocabulary scoped to the wrong owner would write nulls
        into every composite without raising, filing an issue or changing a row count —
        the quietest way this module can be wrong.
        """
        return tuple(k for k in keys if k.value not in self._vocab.coat_levels)

    def cone_id(self, name: str | None) -> int | None:
        """Resolve a cone by name. `"05"` and `"5"` are different cones, never unified."""
        if name is None:
            return None
        return self._vocab.cones.get(name.strip())

    def clay_body_id(self, code: str | None) -> int | None:
        """Resolve a clay by the manufacturer's code. AMACO's `"16"`, Mayco's `"white"` —
        never cast, because only one of the two brands has numbers to cast."""
        if code is None:
            return None
        return self._vocab.clay_bodies.get(code)

    def coat_level_id(self, coat_level: CoatLevel | None) -> int | None:
        if coat_level is None:
            return None
        return self._vocab.coat_levels.get(coat_level.value)

    def resolve_appearance(
        self,
        *,
        cone: str | None = None,
        clay_body_code: str | None = None,
        form: FormKind | None = None,
        coat_level: CoatLevel | None = None,
    ) -> Resolution:
        resolution = Resolution()

        if cone is not None:
            resolution.cone_id = self.cone_id(cone)
            if resolution.cone_id is None:
                resolution.note("unknown_cone", cone)

        if clay_body_code is not None:
            resolution.clay_body_id = self.clay_body_id(clay_body_code)
            if resolution.clay_body_id is None:
                resolution.note("unknown_clay_body", clay_body_code)

        if form is not None:
            resolution.form_id = self._vocab.forms.get(form.value)
            if resolution.form_id is None:
                resolution.note("unknown_form", form.value)

        if coat_level is not None:
            resolution.coat_level_id = self._vocab.coat_levels.get(coat_level.value)
            if resolution.coat_level_id is None:
                resolution.note("unknown_coat_level", coat_level.value)

        return resolution

    def resolve_glaze(
        self, *, surface: Surface | None = None, opacity: Opacity | None = None
    ) -> Resolution:
        resolution = Resolution()
        if surface is not None:
            resolution.surface_id = self._vocab.surfaces.get(surface.value)
            if resolution.surface_id is None:
                resolution.note("unknown_surface", surface.value)
        if opacity is not None:
            resolution.opacity_id = self._vocab.opacities.get(opacity.value)
            if resolution.opacity_id is None:
                resolution.note("unknown_opacity", opacity.value)
        return resolution


def load_vocabularies(conn: object, *, manufacturer: ManufacturerKey) -> Vocabularies:
    """Read every lookup table into memory. They are tiny and never change mid-run.

    ``manufacturer`` is keyword-only and has no default on purpose. A default of `amaco`
    is precisely how the pipeline used to feed a second source the first one's data
    (roadmap F3), and the two tables scoped below are the two where that is a silent
    wrong answer rather than a crash.
    """

    def fetch(table: str, key: str) -> dict[str, int]:
        rows = conn.execute(f"select {key}, id from {table}").fetchall()  # type: ignore[attr-defined]
        return {str(name): int(row_id) for name, row_id in rows}

    def fetch_owned(table: str, key: str, owner: int) -> dict[str, int]:
        rows = conn.execute(  # type: ignore[attr-defined]
            f"select {key}, id from {table} where manufacturer_id = %s", (owner,)
        ).fetchall()
        return {str(name): int(row_id) for name, row_id in rows}

    manufacturers = fetch("manufacturers", "key")
    owner = manufacturers.get(manufacturer.value)
    if owner is None:
        # The state a half-landed source is in: an enum member added before the migration
        # that seeds its row. F10 passed through exactly this, and an empty vocabulary is
        # worse than a stop — every lookup would miss and every appearance would be null.
        raise LookupError(f"unknown manufacturer {manufacturer.value!r}")

    return Vocabularies(
        manufacturer=manufacturer,
        cones=fetch("cones", "name"),
        clay_bodies=fetch_owned("clay_bodies", "code", owner),
        surfaces=fetch("surfaces", "key"),
        opacities=fetch("opacities", "key"),
        forms=fetch("forms", "key"),
        # Mayco's four brush-coat rows are seeded (20260807000100) and unreachable: they
        # are keyed '1'-'4' while `CoatLevel` is AMACO's four thickness words, and
        # `MaycoAdapter.coat_order` is empty so nothing asks for them. F8b is where the
        # enum widens; `AppearanceWriter.existing_pixel_data` is the other seam it touches.
        coat_levels=fetch_owned("coat_levels", "key", owner),
        manufacturers=manufacturers,
    )

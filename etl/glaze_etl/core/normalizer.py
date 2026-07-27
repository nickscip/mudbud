"""Maps scraped values onto the seeded vocabularies' primary keys.

This is the layer that refuses to invent things. The grammar yields human-facing values —
clay number `16`, cone name `"05"`, opacity `"opaque"` — while every column in
`appearances` is a foreign key. Resolving one to the other is the last chance to notice
that a value is not in our vocabulary, and the rule is that an unknown value becomes a
reported issue rather than a null that looks like "not stated".

Two subtleties worth stating outright:

* **Cone names are not numbers.** `05` is far cooler than `5`, so they are matched as
  text against `cones.name` and never cast. The seeded ids are ordered by temperature,
  which is what makes range queries integer arithmetic later.
* **Layering needs two passes.** `PG-55overSM-11` cannot resolve SM-11 to a glaze id
  while SM-11 may not be loaded yet, so the Loader records the code and links it after
  every product exists.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from glaze_etl.core.models import CoatLevel, FormKind, Opacity, Surface


@dataclass(frozen=True)
class Vocabularies:
    """Lookup ids, read once per run from the database."""

    cones: dict[str, int]
    """Cone *name* to id: {"05": 18, "5": 27, "6": 28}."""
    clay_bodies: dict[str, int]
    """AMACO clay code to id: {"16": 2, "32": 5}."""
    surfaces: dict[str, int]
    opacities: dict[str, int]
    forms: dict[str, int]
    coat_levels: dict[str, int]
    manufacturers: dict[str, int]


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

    def cone_id(self, name: str | None) -> int | None:
        """Resolve a cone by name. `"05"` and `"5"` are different cones, never unified."""
        if name is None:
            return None
        return self._vocab.cones.get(name.strip())

    def clay_body_id(self, number: int | None) -> int | None:
        if number is None:
            return None
        return self._vocab.clay_bodies.get(str(number))

    def coat_level_id(self, coat_level: CoatLevel | None) -> int | None:
        if coat_level is None:
            return None
        return self._vocab.coat_levels.get(coat_level.value)

    def resolve_appearance(
        self,
        *,
        cone: str | None = None,
        clay_body_number: int | None = None,
        form: FormKind | None = None,
        coat_level: CoatLevel | None = None,
    ) -> Resolution:
        resolution = Resolution()

        if cone is not None:
            resolution.cone_id = self.cone_id(cone)
            if resolution.cone_id is None:
                resolution.note("unknown_cone", cone)

        if clay_body_number is not None:
            resolution.clay_body_id = self.clay_body_id(clay_body_number)
            if resolution.clay_body_id is None:
                resolution.note("unknown_clay_body", str(clay_body_number))

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


def load_vocabularies(conn: object) -> Vocabularies:
    """Read every lookup table into memory. They are tiny and never change mid-run."""

    def fetch(table: str, key: str) -> dict[str, int]:
        rows = conn.execute(f"select {key}, id from {table}").fetchall()  # type: ignore[attr-defined]
        return {str(name): int(row_id) for name, row_id in rows}

    return Vocabularies(
        cones=fetch("cones", "name"),
        clay_bodies=fetch("clay_bodies", "code"),
        surfaces=fetch("surfaces", "key"),
        opacities=fetch("opacities", "key"),
        forms=fetch("forms", "key"),
        coat_levels=fetch("coat_levels", "key"),
        manufacturers=fetch("manufacturers", "key"),
    )

"""Turns a measured colour into words, so full-text search can find it.

This exists because of a gap that is easy to miss until search is already built.
Potters search by colour — "sage green", "oxblood" — but no AMACO glaze is *named*
sage, and trigram similarity between "sage" and "Serpentine Green" is essentially zero
(no shared 3-grams). Worse, `websearch_to_tsquery` ANDs its terms, so a two-word colour
query matches nothing at all unless both words are somewhere in the index.

So the colour we measured off the photograph is matched against a vocabulary of colour
terms with known LAB centroids, and the winning words are written into the glaze's
`color_terms`, which the search vector indexes at weight B. After that, 'sage' finds
Serpentine Green because the literal token really is in the index — no colour arithmetic
in the query path, which is what keeps the search a plain full-text search.
"""

from __future__ import annotations

from dataclasses import dataclass

from glaze_etl.core.color import Lab, delta_e


@dataclass(frozen=True)
class ColorTerm:
    term: str
    centroid: Lab
    max_delta_e: float
    is_potter_term: bool = False
    family: str | None = None
    """The plain colour word this term belongs to — "sage" -> "green".

    Emitted alongside the specific term because `websearch_to_tsquery` ANDs its inputs,
    so without it a glaze matched as "sage" is unreachable by the query "sage green",
    which is how a potter would actually phrase it.
    """


@dataclass(frozen=True)
class NamedColor:
    term: str
    distance: float


class ColorNamer:
    """Matches LAB readings against a seeded vocabulary.

    The vocabulary lives in the `color_terms` table so it can be tuned without a code
    change; it is passed in rather than imported so this class stays pure and testable.
    """

    def __init__(self, vocabulary: list[ColorTerm]) -> None:
        if not vocabulary:
            raise ValueError("color vocabulary is empty; search by colour will not work")
        self._vocabulary = vocabulary
        self._families = {t.term: t.family for t in vocabulary if t.family}

    def name(self, reading: Lab, *, limit: int = 3) -> list[NamedColor]:
        """Every term within its own radius of this colour, nearest first.

        Radii are per-term rather than global: "blue" is meant to be inclusive, while
        "celadon" is a specific claim and should not collect every pale green.
        """
        hits = [
            NamedColor(term.term, distance)
            for term in self._vocabulary
            if (distance := delta_e(reading, term.centroid)) <= term.max_delta_e
        ]
        hits.sort(key=lambda hit: hit.distance)
        return hits[:limit]

    def terms_for(self, dominant: Lab, secondary: Lab | None = None) -> list[str]:
        """Search terms for one appearance, dominant colour first.

        The secondary colour earns fewer terms: on a break-and-pool glaze it is real and
        worth finding, but it should not outweigh the colour the glaze mostly is.
        """
        ordered: list[str] = []
        for hit in self.name(dominant, limit=3):
            ordered.append(hit.term)
            ordered.extend(self._family_of(hit.term))
        if secondary is not None:
            for hit in self.name(secondary, limit=1):
                ordered.append(hit.term)
                ordered.extend(self._family_of(hit.term))
        # dict preserves insertion order, so this dedupes without losing the ranking.
        return list(dict.fromkeys(ordered))

    def _family_of(self, term: str) -> list[str]:
        family = self._families.get(term)
        return [family] if family else []

"""Every source the ETL can ingest, keyed by manufacturer.

Adding a source means one subclass package and one entry here — every command resolves
its adapter through `adapter_for`, so nothing else changes. Deliberately not in `core/`:
core never imports from sources (that import direction is enforced by a test), while
this package exists to know them all.
"""

from __future__ import annotations

from collections.abc import Callable

from glaze_etl.core.models import ManufacturerKey
from glaze_etl.core.source_adapter import SourceAdapter
from glaze_etl.sources.amaco.adapter import AmacoAdapter
from glaze_etl.sources.mayco.adapter import MaycoAdapter

SOURCES: dict[ManufacturerKey, Callable[[], SourceAdapter]] = {
    ManufacturerKey.AMACO: AmacoAdapter,
    ManufacturerKey.MAYCO: MaycoAdapter,
}


def adapter_for(key: ManufacturerKey | str) -> SourceAdapter:
    """Resolve a manufacturer key — CLI string or enum member — to a fresh adapter.

    Both failure paths raise the same ValueError: a string that is not a
    ManufacturerKey at all, and a member that exists but has no adapter registered
    yet — the half-landed state of adding a source's enum member and migration
    before its adapter package.
    """
    known = ", ".join(sorted(m.value for m in SOURCES))
    try:
        member = ManufacturerKey(key)
    except ValueError:
        raise ValueError(f"no adapter for {key!r}; known sources: {known}") from None
    build = SOURCES.get(member)
    if build is None:
        raise ValueError(f"no adapter for {key!r}; known sources: {known}")
    return build()

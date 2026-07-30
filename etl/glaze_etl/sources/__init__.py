"""Every source the ETL can ingest, keyed by manufacturer.

Adding a source means one subclass package and one entry here — the CLI and the
Temporal activities both resolve adapters through `adapter_for`, so nothing else
changes. Deliberately not in `core/`: core never imports from sources (that import
direction is enforced by a test), while this package exists to know them all.
"""

from __future__ import annotations

from collections.abc import Callable

from glaze_etl.core.models import ManufacturerKey
from glaze_etl.core.source_adapter import SourceAdapter
from glaze_etl.sources.amaco.adapter import AmacoAdapter

SOURCES: dict[ManufacturerKey, Callable[[], SourceAdapter]] = {
    ManufacturerKey.AMACO: AmacoAdapter,
}


def adapter_for(key: ManufacturerKey | str) -> SourceAdapter:
    """Resolve a manufacturer key — CLI string or enum member — to a fresh adapter."""
    try:
        member = ManufacturerKey(key)
    except ValueError:
        known = ", ".join(sorted(m.value for m in SOURCES))
        raise ValueError(f"no adapter for {key!r}; known sources: {known}") from None
    return SOURCES[member]()

"""Fail unless statement coverage AND branch coverage each clear the floor.

`pytest --cov-fail-under` compares one number: coverage.py's blended total, which is
(covered statements + covered branches) / (statements + branches). That lets a suite pass at
90.85% overall while branches sit at 85% — exactly the shape a happy-path-only suite takes, and
exactly what turning `branch = true` on was meant to catch. So the two are checked here on their
own, from the JSON report the CI step writes alongside the terminal one.

coverage.py has no function metric; statements and branches are the two it measures, and the two
gated here. Run after pytest, from `etl/`:

    uv run pytest --cov=glaze_etl --cov-report=json
    uv run python check_coverage.py [floor]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT_FLOOR = 90.0


def main(argv: list[str]) -> int:
    floor = float(argv[1]) if len(argv) > 1 else DEFAULT_FLOOR
    report = Path(argv[2]) if len(argv) > 2 else Path("coverage.json")
    if not report.exists():
        print(
            f"check_coverage: {report} not found — run pytest with --cov-report=json",
            file=sys.stderr,
        )
        return 2

    totals = json.loads(report.read_text())["totals"]
    metrics = {
        "statements": float(totals["percent_statements_covered"]),
        "branches": float(totals["percent_branches_covered"]),
    }

    failed = False
    for name, value in metrics.items():
        verdict = "ok  " if value >= floor else "FAIL"
        print(f"{verdict} {name:<10} {value:6.2f}%  (floor {floor:.0f}%)")
        failed |= value < floor
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

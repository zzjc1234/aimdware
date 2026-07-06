"""Parse a roster CSV: columns `name, student_id, jaccount`.

Used by the admin CLI's `--csv` batch modes. UTF-8 (BOM tolerated), an
optional header row is skipped, blank lines are skipped, and `jaccount` is
the only strictly-required cell.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass


@dataclass(frozen=True)
class RosterRow:
    name: str
    student_id: str | None
    jaccount: str


def read_roster(path: str) -> list[RosterRow]:
    """Read a roster file into rows. Raises ValueError on a malformed row."""
    rows: list[RosterRow] = []
    # utf-8-sig strips a leading BOM if present (Excel-exported CSVs have one).
    with open(path, encoding="utf-8-sig", newline="") as f:
        for fields in csv.reader(f):
            cells = [c.strip() for c in fields]
            if not any(cells):  # blank line
                continue
            if len(cells) < 3:
                raise ValueError(
                    f"roster row needs 3 columns (name,student_id,jaccount): {fields!r}"
                )
            name, student_id, jaccount = cells[0], cells[1], cells[2]
            # A header row (literal 'jaccount' in the jaccount column) is skipped
            # so the TT can keep the friendly `名字,学号,jaccount` header.
            if jaccount.lower() == "jaccount":
                continue
            if not jaccount:
                raise ValueError(f"roster row is missing jaccount: {fields!r}")
            rows.append(RosterRow(name=name, student_id=student_id or None, jaccount=jaccount))
    return rows

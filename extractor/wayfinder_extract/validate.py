"""Arithmetic the document must satisfy before we publish any of it.

A balance sheet that does not balance means we read the wrong column, and a
wrong turnover is worse than no turnover.
"""

# Rounding in published statements is at the cent; allow a little more for
# statements printed in thousands.
TOLERANCE_RATIO = 0.005
TOLERANCE_ABS = 1.0


def _close(a: float, b: float) -> bool:
    scale = max(abs(a), abs(b), 1.0)
    return abs(a - b) <= max(TOLERANCE_ABS, scale * TOLERANCE_RATIO)


def check_identities(values: dict) -> tuple[bool, list[str]]:
    """values: figure key -> float. Returns (ok, problems)."""
    problems = []

    total = values.get("total_assets")
    liab_total = values.get("total_equity_and_liabilities")
    if total is not None and liab_total is not None and not _close(total, liab_total):
        problems.append(
            f"total_assets {total} != total_equity_and_liabilities {liab_total}"
        )

    parts = [values.get(k) for k in
             ("equity", "long_term_liabilities", "short_term_liabilities")]
    if total is not None and all(p is not None for p in parts):
        if not _close(total, sum(parts)):
            problems.append(
                f"total_assets {total} != equity+liabilities {sum(parts)}"
            )

    return (not problems), problems

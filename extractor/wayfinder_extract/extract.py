"""bytes -> dict. The only thing this module knows is PDFs.

It does not know about Cloudflare, GitHub, HTTP or the GEMI API, so it can be
run and tested against real balance sheets offline.
"""
import io
import re
from typing import Any

import pdfplumber

from . import labels
from .text import is_money, normalize, parse_money
from .validate import check_identities

ROW_TOLERANCE = 3.0          # points; two words on the same printed line
MIN_TEXT_CHARS = 200         # below this a PDF is a scan, not a document
MIN_CHARS_PER_TEXT_PAGE = 300  # a page with less is a scanned image with a stamp

_YEAR = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
_GEMI = re.compile(r"Γ\s*\.?\s*Ε\s*\.?\s*ΜΗ\s*\.?\s*:?\s*(\d{9,14})")
_AFM = re.compile(r"Α\s*\.?\s*Φ\s*\.?\s*Μ\s*\.?\s*:?\s*(\d{9})")
_PERIOD_END = re.compile(r"έως\s*(\d{2})/(\d{2})/((?:19|20)\d{2})")
_THOUSANDS = re.compile(r"ΠΟΣΑ ΣΕ ΧΙΛΙΑΔΕΣ")
# GEMI announcements for ESEF/XHTML filers carry no tables: the statements
# live behind a QR link, so there is nothing in the PDF to extract.
_ELSEWHERE = re.compile(
    r"ΔΙΑΔΡΑΣΤΙΚΟ ΣΥΝΔΕΣΜΟ|ΜΟΝΑΔΙΚΟΣ ΣΥΝΔΕΣΜΟΣ|QR ΚΩΔΙΚ|XHTML|ESEF"
)
_UNITS = re.compile(r"ΠΟΣΑ ΣΕ (?:ΕΥΡΩ|Ε)\b|ΠΟΣΑ ΣΕ $")


GLUE_GAP = 1.0               # points; below this two "words" are one word


def _merge_tight(words: list[dict]) -> list[dict]:
    """Re-join words a stray space glyph split mid-token.

    Real GEMI filings contain space characters printed inside numbers, so
    pdfplumber reports '2024' as '202' + '4'. Printed word spacing is never
    this narrow, so glueing on a sub-point gap is safe.
    """
    out: list[dict] = []
    for w in words:
        if out and w["x0"] - out[-1]["x1"] <= GLUE_GAP:
            prev = out[-1]
            out[-1] = {**prev,
                       "text": prev["text"] + w["text"],
                       "x1": w["x1"],
                       "top": min(prev["top"], w["top"]),
                       "bottom": max(prev["bottom"], w["bottom"])}
        else:
            out.append(dict(w))
    return out


def _rows(page) -> list[list[dict]]:
    """Group a page's words into printed lines, left to right."""
    buckets: dict[int, list[dict]] = {}
    for w in page.extract_words(use_text_flow=False, keep_blank_chars=False):
        buckets.setdefault(int(w["top"] / ROW_TOLERANCE), []).append(w)
    return [_merge_tight(sorted(ws, key=lambda w: w["x0"]))
            for _, ws in sorted(buckets.items())]


def _split_row(words: list[dict]) -> tuple[str, list[dict]]:
    money = [w for w in words if is_money(w["text"])]
    label = " ".join(w["text"] for w in words if w not in money)
    return label, money


def _year_columns(row_text: str, words: list[dict]):
    """If this printed line is a column header, return the years left to right.

    A header names two consecutive years. Document headers such as
    'από 01/01/2024 έως 31/12/2024' name only one and are ignored.
    """
    years = _YEAR.findall(row_text)
    distinct = list(dict.fromkeys(years))
    if len(distinct) != 2:
        return None
    a, b = int(distinct[0]), int(distinct[1])
    if abs(a - b) != 1:
        return None
    # Order by where each year first appears on the line.
    positions = {}
    for w in words:
        for y in _YEAR.findall(w["text"]):
            positions.setdefault(y, w["x0"])
    if len(positions) != 2:
        return None
    ordered = sorted(positions, key=lambda y: positions[y])
    return [int(y) for y in ordered]



def _all_headers(pages) -> list[list[int]]:
    out = []
    for _, _, rows in pages:
        for words in rows:
            header = _year_columns(" ".join(w["text"] for w in words), words)
            if header:
                out.append(header)
    return out


def _pick_fiscal_year(headers, period_end_years, notes) -> int | None:
    """Two independent sources must agree on which year we are reporting.

    The column headers say which years the table prints; the announcement text
    says which periods the filing covers. We only accept a year both agree on,
    because picking the wrong one silently publishes last year's turnover.
    """
    if not headers:
        notes.append("no year column header found in the document")
        return None
    header_years = {max(h) for h in headers}
    if len(header_years) != 1:
        notes.append(f"column headers disagree on the current year: {sorted(header_years)}")
        return None
    year = header_years.pop()
    if period_end_years and year not in period_end_years:
        notes.append(
            f"column header year {year} is not among the reporting periods "
            f"{period_end_years} named in the text"
        )
        return None
    return year



def _why_no_table(headers, text_pages, total_pages, full_text) -> str:
    """Name the actual obstacle, so the site can say something true about it."""
    if headers:
        return "ambiguous_fiscal_year"
    if text_pages <= max(1, total_pages // 4):
        return "no_text_layer"
    if _ELSEWHERE.search(normalize(full_text)):
        return "statements_not_attached"
    return "no_financial_table"


def _document_facts(full_text: str) -> dict:
    norm = normalize(full_text)
    facts: dict[str, Any] = {
        "ar_gemi": None, "afm": None, "fiscal_year": None,
        "unit_multiplier": 1, "currency": "EUR", "period_end_years": [],
    }
    m = _GEMI.search(full_text)
    if m:
        facts["ar_gemi"] = m.group(1).zfill(12)
    m = _AFM.search(full_text)
    if m:
        facts["afm"] = m.group(1)

    # A GEMI announcement often names two periods: the one being published and
    # the next one, for which auditors were appointed. Keep both candidates and
    # let the column headers decide which is the reporting period.
    facts["period_end_years"] = sorted(
        {int(y) for _, _, y in _PERIOD_END.findall(full_text)}
    )
    if len(facts["period_end_years"]) == 1:
        facts["fiscal_year"] = facts["period_end_years"][0]

    if _THOUSANDS.search(norm):
        facts["unit_multiplier"] = 1000
    return facts


def _refuse(reason: str, facts: dict | None = None) -> dict:
    out = {
        "status": "unparseable", "reason": reason, "figures": {},
        "ar_gemi": None, "afm": None, "fiscal_year": None,
        "unit_multiplier": 1, "currency": "EUR", "notes": [],
    }
    if facts:
        out.update({k: facts[k] for k in
                    ("ar_gemi", "afm", "fiscal_year", "unit_multiplier", "currency")})
    return out


def extract(pdf_bytes: bytes) -> dict:
    try:
        pdf = pdfplumber.open(io.BytesIO(pdf_bytes))
    except Exception:
        return _refuse("not_a_pdf")

    with pdf:
        pages = [(i, p, _rows(p)) for i, p in enumerate(pdf.pages)]
        page_texts = [p.extract_text() or "" for _, p, _ in pages]
        full_text = "\n".join(page_texts)
        if len(full_text.strip()) < MIN_TEXT_CHARS:
            return _refuse("no_text_layer")
        text_pages = sum(1 for t in page_texts if len(t.strip()) >= MIN_CHARS_PER_TEXT_PAGE)

        facts = _document_facts(full_text)
        notes: list[str] = []

        headers = _all_headers(pages)
        facts["fiscal_year"] = _pick_fiscal_year(
            headers, facts["period_end_years"], notes
        )
        if facts["fiscal_year"] is None:
            out = _refuse(
                _why_no_table(headers, text_pages, len(pages), full_text), facts
            )
            out["notes"] = notes
            return out

        found: dict[str, dict] = {}
        columns: list[int] | None = None

        for page_index, page, rows in pages:
            for words in rows:
                row_text = " ".join(w["text"] for w in words)
                header = _year_columns(row_text, words)
                if header:
                    columns = header
                    continue

                label_raw, money = _split_row(words)
                if not money:
                    continue
                key = labels.match(normalize(label_raw))
                if key is None or key in found:
                    continue

                if columns is None:
                    notes.append(f"{key}: no year header seen before this row")
                    continue
                if facts["fiscal_year"] not in columns:
                    notes.append(
                        f"{key}: column header {columns} does not contain "
                        f"fiscal year {facts['fiscal_year']}"
                    )
                    continue
                if len(money) != len(columns):
                    # e.g. an accumulated-depreciation row carrying a sub-column.
                    notes.append(
                        f"{key}: {len(money)} amounts for {len(columns)} year columns"
                    )
                    continue

                word = money[columns.index(facts["fiscal_year"])]
                found[key] = {
                    "value": parse_money(word["text"]) * facts["unit_multiplier"],
                    "page": page_index + 1,
                    "bbox": [round(word["x0"], 2), round(word["top"], 2),
                             round(word["x1"], 2), round(word["bottom"], 2)],
                    "page_width": round(page.width, 2),
                    "page_height": round(page.height, 2),
                    "label_matched": label_raw.strip(),
                    "source": "extracted",
                }

    values = {k: v["value"] for k, v in found.items()}
    ok, problems = check_identities(values)
    if not ok:
        # We read a column wrong somewhere. Drop everything the identity covers.
        for k in ("total_assets", "equity", "long_term_liabilities",
                  "short_term_liabilities", "total_equity_and_liabilities"):
            found.pop(k, None)
        notes.extend(problems)

    _derive_ebitda(found, notes)

    figures = {k: v for k, v in found.items() if k in labels.PUBLIC}
    missing = [k for k in labels.PUBLIC if k not in figures]
    if not figures:
        out = _refuse("no_recognised_line_items", facts)
        out["notes"] = notes
        return out

    return {
        "status": "parsed" if not missing else "partial",
        "reason": None,
        "ar_gemi": facts["ar_gemi"],
        "afm": facts["afm"],
        "fiscal_year": facts["fiscal_year"],
        "unit_multiplier": facts["unit_multiplier"],
        "currency": facts["currency"],
        "figures": figures,
        "missing": missing,
        "notes": notes,
    }


def _derive_ebitda(found: dict, notes: list) -> None:
    """EBITDA = pre-tax result, with interest and depreciation added back.

    Only when both are printed as expenses (negative). A statement that shows
    them positive uses a different sign convention and we would flip the sign.
    """
    need = ("pre_tax_profit", "interest", "depreciation")
    if any(k not in found for k in need):
        notes.append("ebitda: not derived, missing " +
                     ",".join(k for k in need if k not in found))
        return
    interest = found["interest"]["value"]
    depreciation = found["depreciation"]["value"]
    if interest > 0 or depreciation > 0:
        notes.append("ebitda: not derived, interest/depreciation not shown as expenses")
        return
    found["ebitda"] = {
        "value": round(found["pre_tax_profit"]["value"] - interest - depreciation, 2),
        "source": "derived",
        "derived_from": list(need),
        "formula": "pre_tax_profit - interest - depreciation",
    }

#!/usr/bin/env python3
"""Collect real balance-sheet PDFs as extractor fixtures, at a legal pace.

GEMI allows 8 requests per minute for the whole key. Every call this script
makes waits at least MIN_GAP seconds after the previous one, so it can never
burst, and it stops entirely on a 429.
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://opendata-api.businessportal.gr/api/opendata/v1"
MIN_GAP = 10.1
FIXTURES = Path(__file__).resolve().parent.parent / "extractor" / "fixtures"

_last = 0.0


def _key() -> str:
    for line in Path.home().joinpath(".config/wayfinder/env").read_text().splitlines():
        if line.startswith("GEMI_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no GEMI_API_KEY in ~/.config/wayfinder/env")


API_KEY = _key()


def call(path: str, params: dict | None = None, binary: bool = False):
    global _last
    wait = MIN_GAP - (time.monotonic() - _last)
    if wait > 0:
        time.sleep(wait)
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, encoding="utf-8")
    req = urllib.request.Request(url, headers={"api_key": API_KEY})
    _last = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print("429 from GEMI — stopping", file=sys.stderr)
            raise SystemExit(2)
        print(f"HTTP {e.code} on {path}", file=sys.stderr)
        return None
    return body if binary else json.loads(body)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s).translate(dict.fromkeys(range(0x300, 0x370)))
    return unicodedata.normalize("NFC", s).upper().replace("ς", "Σ")


FINANCIAL = re.compile(r"ΙΣΟΛΟΓΙΣΜ|ΟΙΚΟΝΟΜΙΚ(ΕΣ|ΩΝ) ΚΑΤΑΣΤΑΣ|ΧΡΗΜΑΤΟΟΙΚΟΝΟΜΙΚ")


def newest_financial(docs: dict):
    rows = []
    for bucket in ("decision", "publication"):
        for d in docs.get(bucket, []) or []:
            text = norm(" ".join(str(d.get(k) or "") for k in
                                 ("summary", "decisionSubject", "title")))
            if FINANCIAL.search(text):
                url = d.get("assemblyDecisionUrl") or d.get("url") or d.get("fileUrl")
                if url:
                    rows.append((d.get("dateRegistrated") or "", url, text[:70]))
    rows.sort(reverse=True)
    return rows[0] if rows else None


def grab(ar_gemi: str, tag: str):
    ar = ar_gemi.zfill(12)
    out_dir = FIXTURES
    if any(p.name.startswith(ar) for p in out_dir.glob("*.pdf")):
        print(f"skip {ar} ({tag}): already have a fixture")
        return
    docs = call(f"/companies/{ar}/documents")
    if not docs:
        return
    hit = newest_financial(docs)
    if not hit:
        print(f"{ar} ({tag}): no financial-statement filing found")
        return
    date, url, summary = hit
    q = urllib.parse.urlparse(url).query
    blob = call("/downloadFile?" + q, binary=True)
    if not blob or not blob.startswith(b"%PDF"):
        print(f"{ar} ({tag}): download did not return a PDF")
        return
    name = f"{ar}_{date[:4]}_{tag}.pdf"
    (out_dir / name).write_bytes(blob)
    print(f"saved {name}  ({len(blob)//1024} KB)  {summary}")


def find(name: str, legal_type: str | None = None):
    params = {"name": name, "resultsSize": "10"}
    if legal_type:
        params["legalTypes"] = legal_type
    res = call("/companies", params)
    if not res:
        return []
    target = norm(name)
    scored = []
    for c in res.get("searchResults", []):
        label = norm(c.get("coNameEl") or "")
        score = sum(1 for tok in target.split() if tok in label)
        scored.append((score, c["arGemi"], c.get("coNameEl"), c["legalType"]["descr"]))
    scored.sort(reverse=True)
    return scored


if __name__ == "__main__":
    # (search term, legal type id, fixture tag)
    WANTED = [
        ("ΠΛΑΙΣΙΟ COMPUTERS", "1", "large_ae"),
        ("ΚΡΙ ΚΡΙ ΒΙΟΜΗΧΑΝΙΑ ΓΑΛΑΚΤΟΣ", "1", "mid_ae"),
        ("ΤΙΤΑΝ ΤΣΙΜΕΝΤΑ", "1", "xl_ae"),
    ]
    for term, lt, tag in WANTED:
        hits = find(term, lt)
        if not hits:
            print(f"no match for {term}")
            continue
        score, ar, label, form = hits[0]
        print(f"{term} -> {ar} {label} [{form}] (score {score})")
        grab(ar, tag)
    print("done")

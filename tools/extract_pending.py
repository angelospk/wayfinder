#!/usr/bin/env python3
"""Read balance sheets for companies we have not parsed yet, and store the result.

Runs on a GitHub Actions runner, not on Cloudflare: parsing a PDF needs far more
than the 10 ms of CPU a free Worker gets per request.

It never talks to GEMI directly. Every registry call goes through the public
Worker routes, so the one dispatcher that paces traffic stays the only thing
holding the API key and the only thing counting against the 8/min limit.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "extractor"))
from wayfinder_extract import extract  # noqa: E402

DATA_DIR = ROOT / "data" / "financials"
FINANCIAL = re.compile(r"ΙΣΟΛΟΓΙΣΜ|ΟΙΚΟΝΟΜΙΚ(ΕΣ|ΩΝ) ΚΑΤΑΣΤΑΣ|ΧΡΗΜΑΤΟΟΙΚΟΝΟΜΙΚ")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s).translate(dict.fromkeys(range(0x300, 0x370)))
    return unicodedata.normalize("NFC", s).upper().replace("ς", "Σ")


def d1(sql: str) -> list[dict]:
    """Run SQL against the remote D1 database with the Cloudflare API token."""
    out = subprocess.run(
        ["npx", "--yes", "wrangler@4", "d1", "execute", "wayfinder",
         "--remote", "--json", "--command", sql],
        cwd=ROOT / "worker", capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise SystemExit(f"d1 failed: {out.stderr[-2000:]}")
    # wrangler prints a banner before the JSON, and nothing at all when it fails
    # in a way that still exits 0.
    start = out.stdout.find("[")
    if start < 0:
        raise SystemExit(f"d1 returned no JSON:\n{out.stdout[-2000:]}\n{out.stderr[-1000:]}")
    payload = json.loads(out.stdout[start:])
    return payload[0].get("results", [])


def api(base: str, path: str, expect_json=True, tries=12):
    """GET a Worker route, waiting out the 202 the pacing dispatcher returns."""
    for attempt in range(tries):
        req = urllib.request.Request(base + path, headers={
            "accept": "*/*",
            # Cloudflare answers 403 to urllib's default agent string.
            "user-agent": "wayfinder-extractor/1.0 (+https://github.com/haroldpoi/wayfinder)",
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
                return json.loads(body) if expect_json else body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (202, 503):
                pass
            elif e.code >= 500:
                pass
            else:
                print(f"  HTTP {e.code} on {path}", file=sys.stderr)
                return None
        except urllib.error.URLError as e:
            print(f"  network error on {path}: {e}", file=sys.stderr)
        wait = min(5 + attempt * 5, 30)
        time.sleep(wait)
    print(f"  gave up on {path}", file=sys.stderr)
    return None


def api_json(base: str, path: str):
    """Worker envelopes: 202 arrives as a 200 with data=null, so poll on that."""
    for attempt in range(12):
        body = api(base, path)
        if body is None:
            return None
        if body.get("data") is not None:
            return body["data"]
        state = (body.get("meta") or {}).get("state")
        if state in ("not_found", "unavailable"):
            return None
        time.sleep(min(5 + attempt * 5, 30))
    return None


def newest_financial(docs: dict):
    rows = []
    for bucket in docs.values():
        if not isinstance(bucket, list):
            continue
        for d in bucket:
            text = norm(" ".join(str(d.get(k) or "") for k in ("summary", "decisionSubject")))
            if not FINANCIAL.search(text):
                continue
            url = d.get("assemblyDecisionUrl") or ""
            m = re.search(r"[?&]elementId=(\d+)", url)
            if m:
                rows.append((d.get("dateRegistrated") or "", m.group(1)))
    rows.sort(reverse=True)
    return rows[0] if rows else None


def sql_quote(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def process(base: str, ar_gemi: str) -> dict | None:
    print(f"[{ar_gemi}] documents…")
    docs = api_json(base, f"/api/company/{ar_gemi}/documents")
    if not docs:
        return {"ar_gemi": ar_gemi, "status": "unparseable", "reason": "no_documents",
                "fiscal_year": 0, "figures": {}, "unit_multiplier": 1}
    hit = newest_financial(docs)
    if not hit:
        return {"ar_gemi": ar_gemi, "status": "unparseable", "reason": "no_financial_filing",
                "fiscal_year": 0, "figures": {}, "unit_multiplier": 1}
    date, element_id = hit

    print(f"[{ar_gemi}] pdf elementId={element_id} ({date})")
    blob = api(base, f"/api/company/{ar_gemi}/document/{element_id}", expect_json=False)
    if not blob or not blob.startswith(b"%PDF"):
        return {"ar_gemi": ar_gemi, "status": "unparseable", "reason": "download_failed",
                "fiscal_year": 0, "figures": {}, "unit_multiplier": 1}

    result = extract(blob)
    result["ar_gemi"] = result.get("ar_gemi") or ar_gemi
    result["source_element_id"] = element_id
    result["source_registered"] = date
    if not result.get("fiscal_year"):
        # Keep the refusal, but under a year we can key on: the filing year.
        result["fiscal_year"] = int(date[:4]) if date[:4].isdigit() else 0
    print(f"[{ar_gemi}] {result['status']} {result.get('reason') or ''} "
          f"year={result['fiscal_year']} figures={len(result.get('figures', {}))}")
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default=os.environ.get("WAYFINDER_API_BASE", ""))
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--ar-gemi", action="append", default=[],
                    help="parse these instead of picking from the queue")
    args = ap.parse_args()
    if not args.api_base:
        raise SystemExit("--api-base or WAYFINDER_API_BASE is required")
    base = args.api_base.rstrip("/")

    if args.ar_gemi:
        targets = [a.zfill(12) for a in args.ar_gemi]
    else:
        rows = d1(
            "SELECT ar_gemi FROM snapshots WHERE kind = 'profile' AND ar_gemi IS NOT NULL "
            "AND ar_gemi NOT IN (SELECT ar_gemi FROM financials) "
            f"ORDER BY fetched_at DESC LIMIT {int(args.limit)}"
        )
        targets = [r["ar_gemi"] for r in rows]

    if not targets:
        print("nothing to parse")
        return 0
    print(f"{len(targets)} to parse: {', '.join(targets)}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    statements = []
    for ar in targets:
        result = process(base, ar)
        if not result:
            continue
        (DATA_DIR / f"{ar}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        statements.append(
            "INSERT INTO financials (ar_gemi, fiscal_year, payload, updated_at) VALUES "
            f"({sql_quote(ar)}, {int(result['fiscal_year'])}, "
            f"{sql_quote(json.dumps(result, ensure_ascii=False))}, {int(time.time() * 1000)}) "
            "ON CONFLICT (ar_gemi, fiscal_year) DO UPDATE SET "
            "payload = excluded.payload, updated_at = excluded.updated_at;"
        )

    for stmt in statements:
        d1(stmt)
    print(f"stored {len(statements)} results")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

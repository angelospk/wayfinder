"""Acceptance tests for the extractor.

The contract: bytes -> dict. No network, no Cloudflare, no GitHub.
A figure is only emitted when the document says it unambiguously.
"""
import json
from pathlib import Path

import pytest

from wayfinder_extract import extract

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _load(name):
    return (FIXTURES / name).read_bytes()


def _golden(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


CASES = sorted(p.name for p in FIXTURES.glob("*.pdf"))


@pytest.mark.parametrize("pdf_name", CASES)
def test_matches_golden(pdf_name):
    golden_path = FIXTURES / (pdf_name[:-4] + ".golden.json")
    if not golden_path.exists():
        pytest.skip(f"no golden file for {pdf_name}")
    expected = _golden(golden_path.name)
    got = extract(_load(pdf_name))

    assert got["status"] == expected["status"]
    assert got.get("reason") == expected.get("reason")
    assert got["ar_gemi"] == expected["ar_gemi"]
    assert got["fiscal_year"] == expected["fiscal_year"]
    assert got["unit_multiplier"] == expected["unit_multiplier"]
    assert got["currency"] == expected["currency"]

    for key, exp in expected["figures"].items():
        assert key in got["figures"], f"missing figure {key}"
        assert got["figures"][key]["value"] == pytest.approx(exp["value"], abs=0.005), key
    extra = set(got["figures"]) - set(expected["figures"])
    assert not extra, f"emitted figures the golden file does not claim: {extra}"


@pytest.mark.parametrize("pdf_name", CASES)
def test_every_figure_carries_provenance(pdf_name):
    """No number may be shown without being locatable in the source PDF."""
    got = extract(_load(pdf_name))
    for key, fig in got["figures"].items():
        if fig["source"] == "derived":
            assert fig["derived_from"], f"{key}: derived figure must name its inputs"
            continue
        assert fig["page"] >= 1, key
        assert len(fig["bbox"]) == 4, key
        assert fig["bbox"][2] > fig["bbox"][0], key
        assert fig["label_matched"], key


def test_not_a_pdf_is_unparseable():
    got = extract(b"this is not a pdf")
    assert got["status"] == "unparseable"
    assert got["reason"] == "not_a_pdf"
    assert got["figures"] == {}


def test_pdf_without_text_layer_is_unparseable(tmp_path):
    """A scanned PDF must be refused, not guessed at."""
    blank = FIXTURES / "_synthetic_no_text.pdf"
    if not blank.exists():
        pytest.skip("synthetic no-text fixture not built")
    got = extract(blank.read_bytes())
    assert got["status"] == "unparseable"
    assert got["reason"] == "no_text_layer"


def test_balance_sheet_identity_is_enforced():
    """total assets must equal equity + liabilities, or we do not publish."""
    from wayfinder_extract.validate import check_identities

    ok, problems = check_identities(
        {"total_assets": 100.0, "equity": 40.0,
         "long_term_liabilities": 35.0, "short_term_liabilities": 25.0}
    )
    assert ok and not problems

    ok, problems = check_identities(
        {"total_assets": 100.0, "equity": 40.0,
         "long_term_liabilities": 35.0, "short_term_liabilities": 30.0}
    )
    assert not ok and problems

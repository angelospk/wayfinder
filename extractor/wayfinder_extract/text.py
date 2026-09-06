"""Greek text and number normalisation."""
import re
import unicodedata

_COMBINING = dict.fromkeys(range(0x300, 0x370))

_MONEY = re.compile(r"^\(?-?\d{1,3}(?:\.\d{3})*(?:,\d+)?\)?-?$|^\(?-?\d+(?:,\d+)?\)?-?$")


def normalize(s: str) -> str:
    """Uppercase, accent-free, punctuation-free, single-spaced.

    Accents, final sigma and stray punctuation vary between accounting
    packages; the label wording does not.
    """
    s = unicodedata.normalize("NFD", s).translate(_COMBINING)
    s = unicodedata.normalize("NFC", s).upper()
    s = s.replace("ς", "Σ")
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def is_money(token: str) -> bool:
    t = token.strip()
    if not t or not any(ch.isdigit() for ch in t):
        return False
    if re.fullmatch(r"\d{4}", t):
        return False  # a bare 4-digit year is a column header, not an amount
    return bool(_MONEY.match(t))


def parse_money(token: str) -> float:
    """'1.124.840,78' -> 1124840.78 ; '(1.234,56)' and '1.234,56-' -> negative."""
    t = token.strip()
    negative = t.startswith("-") or t.endswith("-") or (t.startswith("(") and t.endswith(")"))
    t = t.strip("()-")
    t = t.replace(".", "").replace(",", ".")
    value = float(t)
    return -value if negative else value

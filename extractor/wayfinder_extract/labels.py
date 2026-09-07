"""Which Greek ELP line items we look for, and how to recognise them.

`pattern` matches the normalized (accent-free, uppercase) label of a row.
`forbid` rejects a row that would otherwise match a shorter, wrong item:
'ΣΥΝΟΛΟ ΚΑΘΑΡΗΣ ΘΕΣΗΣ' and 'ΣΥΝΟΛΟ ΚΑΘΑΡΗΣ ΘΕΣΗΣ ΚΑΙ ΥΠΟΧΡΕΩΣΕΩΝ' are two
different numbers separated by two words.
"""
import re

_SPECS = [
    ("turnover",
     r"^ΚΥΚΛΟΣ ΕΡΓΑΣΙΩΝ( ΚΑΘΑΡΟΣ)?$|^ΠΩΛΗΣΕΙΣ$", None),

    ("total_assets",
     r"^ΣΥΝΟΛΟ ΕΝΕΡΓΗΤΙΚΟΥ$|^ΣΥΝΟΛΟ ΠΕΡΙΟΥΣΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ$", None),

    ("total_equity_and_liabilities",
     r"^ΣΥΝΟΛΟ ΚΑΘΑΡΗΣ ΘΕΣΗΣ ΚΑΙ( ΥΠΟΧΡΕΩΣΕΩΝ)?$"
     r"|^ΣΥΝΟΛΟ ΚΑΘΑΡΗΣ ΘΕΣΗΣ ΠΡΟΒΛΕΨΕΩΝ ΚΑΙ ΥΠΟΧΡΕΩΣΕΩΝ$"
     r"|^ΣΥΝΟΛΟ ΠΑΘΗΤΙΚΟΥ$", None),

    ("equity",
     r"^ΚΕΦΑΛΑΙΑ ΚΑΙ ΑΠΟΘΕΜΑΤΙΚΑ$|^ΣΥΝΟΛΟ ΚΑΘΑΡΗΣ ΘΕΣΗΣ$"
     r"|^ΙΔΙΑ ΚΕΦΑΛΑΙΑ$|^ΣΥΝΟΛΟ ΙΔΙΩΝ ΚΕΦΑΛΑΙΩΝ$",
     r"ΥΠΟΧΡΕΩΣ|ΠΡΟΒΛΕΨ"),

    ("long_term_liabilities",
     r"^ΜΑΚΡΟΠΡΟΘΕΣΜΕΣ ΥΠΟΧΡΕΩΣΕΙΣ$|^ΣΥΝΟΛΟ ΜΑΚΡΟΠΡΟΘΕΣΜΩΝ ΥΠΟΧΡΕΩΣΕΩΝ$", None),

    ("short_term_liabilities",
     r"^ΒΡΑΧΥΠΡΟΘΕΣΜΕΣ ΥΠΟΧΡΕΩΣΕΙΣ$|^ΣΥΝΟΛΟ ΒΡΑΧΥΠΡΟΘΕΣΜΩΝ ΥΠΟΧΡΕΩΣΕΩΝ$", None),

    # Printed directly in the "κατά λειτουργία" income statement, where
    # depreciation is folded into cost of sales and cannot be recovered.
    ("ebit",
     r"^ΑΠΟΤΕΛΕΣΜΑΤ?Α? ΠΡΟ ΤΟΚΩΝ ΚΑΙ ΦΟΡΩΝ$|^ΚΕΡΔΗ ΖΗΜΙΕΣ ΠΡΟ ΤΟΚΩΝ ΚΑΙ ΦΟΡΩΝ$", None),

    ("total_liabilities",
     r"^ΣΥΝΟΛΟ ΥΠΟΧΡΕΩΣΕΩΝ$|^ΣΥΝΟΛΟ ΠΡΟΒΛΕΨΕΩΝ ΚΑΙ ΥΠΟΧΡΕΩΣΕΩΝ$", None),

    ("pre_tax_profit",
     r"^ΑΠΟΤΕΛΕΣΜΑΤ?Α? ΠΡΟ ΦΟΡΩΝ$|^ΚΕΡΔΗ ΖΗΜΙΕΣ ΠΡΟ ΦΟΡΩΝ$|^ΚΕΡΔΗ ΠΡΟ ΦΟΡΩΝ$", None),

    ("net_profit",
     r"^ΑΠΟΤΕΛΕΣΜΑ(ΤΑ)? ΠΕΡΙΟΔΟΥ ΜΕΤΑ ΑΠΟ ΦΟΡΟΥΣ$"
     r"|^ΚΑΘΑΡΟ ΑΠΟΤΕΛΕΣΜΑ ΜΕΤΑ ΑΠΟ ΦΟΡΟΥΣ$"
     r"|^ΚΕΡΔΗ ΖΗΜΙΕΣ ΜΕΤΑ ΑΠΟ ΦΟΡΟΥΣ$"
     r"|^ΑΠΟΤΕΛΕΣΜΑΤΑ ΧΡΗΣΗΣ ΜΕΤΑ ΑΠΟ ΦΟΡΟΥΣ$", None),

    ("depreciation",
     r"^ΑΠΟΣΒΕΣΕΙΣ\b.*$", r"ΕΠΙΧΟΡΗΓΗΣΕΩΝ|ΣΩΡΕΥΜΕΝΕΣ"),

    ("interest",
     r"^ΤΟΚΟΙ ΚΑΙ ΣΥΝΑΦΗ ΚΟΝΔΥΛΙΑ( ΚΑΘΑΡΟ ΠΟΣΟ)?$"
     r"|^ΧΡΕΩΣΤΙΚΟΙ ΤΟΚΟΙ ΚΑΙ ΣΥΝΑΦΗ ΕΞΟΔΑ$", None),
]

SPECS = [
    (key, re.compile(pat), re.compile(forbid) if forbid else None)
    for key, pat, forbid in _SPECS
]

# What the site is allowed to show. The rest feed derivation and validation.
PUBLIC = (
    "turnover", "ebitda", "ebit", "net_profit", "pre_tax_profit",
    "total_assets", "equity",
)

# Without these four there is no useful picture of a company, so their absence
# makes a reading "partial". EBIT and EBITDA depend on which income-statement
# format the filer chose, so missing them is normal, not a defect.
REQUIRED = ("turnover", "net_profit", "total_assets", "equity")


def match(label_norm: str):
    """Return the figure key for a normalized row label, or None.

    Order matters: the most specific spec that can match a string is listed
    first, so `total_equity_and_liabilities` is tested before `equity`.
    """
    for key, pattern, forbid in SPECS:
        if pattern.match(label_norm):
            if forbid and forbid.search(label_norm):
                continue
            return key
    return None

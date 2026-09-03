# wayfinder — design

**Ημερομηνία:** 2026-09-03
**Κατάσταση:** εγκεκριμένο σχέδιο, εκκρεμεί implementation plan

## Τι είναι

Δημόσιο site που δείχνει στοιχεία ελληνικών επιχειρήσεων, αντλώντας από το επίσημο
OpenData API του ΓΕΜΗ. Στατικό frontend σε GitHub Pages, δωρεάν σε όλη τη διαδρομή.

Ο χρήστης δίνει ΑΦΜ, αριθμό ΓΕΜΗ ή επωνυμία και βλέπει τα στοιχεία δημοσιότητας της
επιχείρησης, τα δημόσια έγγραφά της, και — όπου έχουμε καταφέρει να τα εξαγάγουμε —
οικονομικά μεγέθη από τους δημοσιευμένους ισολογισμούς.

## Πηγή δεδομένων

**ΓΕΜΗ OpenData API** — `https://opendata-api.businessportal.gr/api/opendata/v1`

- OpenAPI 2.0 spec: `https://opendata-api.businessportal.gr/api-docs`
- Auth: header `api_key`
- Άδεια: **ODC-BY-1.0** — επιτρέπει αναδημοσίευση και εμπορική χρήση, **απαιτεί αναφορά πηγής**
- Εγγραφή: `https://opendata.businessportal.gr/register/` — δωρεάν, με έγκριση της ΚΥ ΓΕΜΗ
- Το δημόσιο test key `api-docs-key` επιστρέφει 401 στο live API (επαληθεύτηκε 2026-09-03)

### Endpoints που χρησιμοποιούμε

| Endpoint | Χρήση |
|---|---|
| `GET /companies` | Αναζήτηση: `afm`, `arGemi`, `name`, `activities`, `legalTypes`, `municipalities`, `prefectures`, `statuses`, `isActive`, pagination |
| `GET /companies/{arGemi}` | Στοιχεία δημοσιότητας μιας επιχείρησης |
| `GET /companies/{arGemi}/documents` | Λίστα δημόσιων εγγράφων (εδώ ζουν οι ισολογισμοί) |
| `GET /downloadFile?key=&elementId=` | Λήψη εγγράφου (PDF) |
| `GET /metadata/*` | Παραμετρικά: δραστηριότητες, νομοί, δήμοι, καταστάσεις, νομικές μορφές, υπηρεσίες ΓΕΜΗ, θέματα αποφάσεων |

**Τι δεν δίνει το API:** οικονομικά μεγέθη ως δεδομένα. Οι ισολογισμοί υπάρχουν μόνο ως
PDF μέσω `/downloadFile`. Αυτό είναι όλη η δυσκολία του project.

## Αρχιτεκτονική

```
GitHub Pages (Astro, static)
      │ fetch
      ▼
Cloudflare Worker (free plan)  ──▶  ΓΕΜΗ OpenData API
   κρατά το api_key                     (στοιχεία δημοσιότητας, live)
   CORS + cache + D1
      │ cache miss στα οικονομικά
      ▼
D1: pending_financials
      │ cron κάθε 15'
      ▼
GitHub Actions (Python)  ──▶  downloadFile → pdfplumber/OCR → JSON
      │
      └─▶ commit σε data/financials/<arGemi>.json  →  Pages rebuild
```

### Γιατί ο parser τρέχει σε GitHub Actions και όχι σε Worker

Το Workers free plan δίνει **10ms CPU ανά HTTP request** (paid: 30s). Parsing PDF θέλει
δευτερόλεπτα CPU, άρα δεν χωράει στο free tier — ούτε σε queue consumer, όπου το όριο
των 15 λεπτών είναι *wall time*, όχι CPU.

Ένα public repo σε GitHub Actions δίνει απεριόριστα λεπτά, πλήρες Python περιβάλλον
(pdfplumber, OCR) και πολύ ευκολότερο debugging. Το τίμημα είναι latency: τα οικονομικά
εμφανίζονται λεπτά αργότερα, όχι άμεσα. Δεκτό, γιατί το site είναι χρήσιμο και χωρίς αυτά.

## Components

Τέσσερα, με σκοπίμως στενά όρια.

### 1. `site/` — Astro, στατικό

Σελίδες: `/` (αναζήτηση), `/company/[arGemi]`, `/about` (αναφορά πηγής, ODC-BY).

Δεν ξέρει τίποτα για το ΓΕΜΗ. Μιλάει μόνο στο Worker και διαβάζει στατικά JSON.
Zero JS by default· islands μόνο στο search box και στα γραφήματα.

**Deploy:** GitHub Actions → GitHub Pages.

### 2. `worker/` — Cloudflare Worker

Το μόνο σημείο που γνωρίζει το `GEMI_API_KEY` (Worker secret, ποτέ στο repo).

| Route | Κάνει |
|---|---|
| `GET /api/search?q=` | Proxy στο `/companies`, normalize του query |
| `GET /api/company/:arGemi` | Proxy + cache |
| `GET /api/company/:arGemi/documents` | Proxy + cache |
| `POST /api/request-financials/:arGemi` | Γράφει γραμμή στο `pending_financials` |
| `GET /api/admin/pending` | Επιστρέφει την ουρά· απαιτεί header `x-admin-token` |
| `POST /api/admin/pending/clear` | Σβήνει όσα ολοκληρώθηκαν· ίδιο token |

Το GitHub Actions διαβάζει την ουρά **μόνο** μέσα από τα δύο `admin` routes, με
`WAYFINDER_ADMIN_TOKEN` ως GitHub secret. Δεν αγγίζει το D1 απευθείας — έτσι το D1
παραμένει ιδιωτικό στο Worker και η ουρά έχει ένα μόνο συμβόλαιο.

Cache: Cloudflare Cache API για GET, TTL 24h. D1 μόνο για την ουρά εργασιών.

**Δεν κάνει parsing. Δεν κάνει OCR. Δεν αποθηκεύει οικονομικά.**

### 3. `extractor/` — Python

Καθαρή συνάρτηση: `bytes (PDF) → dict`. Δεν ξέρει τίποτα για Cloudflare, GitHub ή HTTP.
Τρέχει τοπικά με ένα αρχείο ως όρισμα, ίδιο αποτέλεσμα με το CI.

Έξοδος ανά χρήση:

```json
{
  "ar_gemi": "054414421000",
  "fiscal_year": 2024,
  "status": "parsed",
  "source_document_id": "...",
  "source_page": 3,
  "figures": { "turnover": 0, "ebitda": 0, "net_profit": 0, "total_assets": 0, "equity": 0 }
}
```

`status` ∈ `parsed` | `partial` | `unparseable`. Κάθε ποσό κουβαλά την πηγή του.

### 4. `data/financials/` — το dataset

Committed JSON, ένα αρχείο ανά αριθμό ΓΕΜΗ. Είναι ταυτόχρονα η αποθήκη του site και το
δημόσιο open-data προϊόν του repo.

Το Astro build αντιγράφει τον φάκελο στο `public/data/financials/`, ώστε το site να τα
σερβίρει ως στατικά assets στο ίδιο origin — χωρίς κλήση στο Worker.

## Ροή δεδομένων

1. Ο χρήστης αναζητά → site → Worker → ΓΕΜΗ → αποτελέσματα.
2. Ανοίγει εταιρεία → Worker επιστρέφει στοιχεία δημοσιότητας + λίστα εγγράφων. **Αμέσως.**
3. Το site ζητά `/data/financials/<arGemi>.json`.
   - 200 → δείχνει τα μεγέθη με αναφορά στο έγγραφο-πηγή.
   - 404 → δείχνει «δεν έχουν επεξεργαστεί ακόμα» + links στα PDF, και κάνει
     `POST /api/request-financials`.
4. Cron κάθε 15' → GitHub Actions διαβάζει την ουρά → κατεβάζει PDF → extractor →
   commit → Pages rebuild.

## Χειρισμός σφαλμάτων

Η αρχή: **ποτέ μαντεμένο νούμερο.** Ένας λάθος τζίρος είναι χειρότερος από κανέναν τζίρο.

| Κατάσταση | Συμπεριφορά |
|---|---|
| ΓΕΜΗ API κάτω / 5xx | Σερβίρει cached αντίγραφο, banner με την ηλικία των δεδομένων |
| ΓΕΜΗ 401 (key έληξε) | Worker λογάρει, site δείχνει σφάλμα υπηρεσίας — όχι κενή σελίδα |
| Rate limit ΓΕΜΗ | Backoff στο Worker, 429 προς τα πάνω με `Retry-After` |
| Δεν βρέθηκε εταιρεία | Καθαρό «δεν βρέθηκε», όχι κενό |
| Οικονομικά μη διαθέσιμα | Ρητό μήνυμα + link στο PDF |
| PDF σκαναρισμένο / OCR απέτυχε | `status: unparseable`, το site το λέει, δίνει το PDF |
| Μερική εξαγωγή | `status: partial`, δείχνει μόνο τα πεδία που βρέθηκαν |

## Testing

Τα tests του extractor γράφονται **πριν** τον extractor. Είναι το συμβόλαιο.

- **`extractor/`** — 5-10 πραγματικοί ισολογισμοί ως fixtures στο repo, golden JSON ανά
  fixture, pytest. Καλύπτει: ΑΕ, ΕΠΕ, ΙΚΕ, σκαναρισμένο PDF (αναμένεται `unparseable`),
  πολυετή κατάσταση.
- **`worker/`** — vitest + Miniflare, mocked ΓΕΜΗ responses. Καλύπτει και τα 6 routes,
  cache hit/miss, 401, 429, backoff.
- **`site/`** — `astro build` περνά· ένα Playwright smoke: αναζήτηση → σελίδα εταιρείας →
  εμφανίζεται το μήνυμα «οικονομικά μη διαθέσιμα» όταν λείπει το JSON.

## Ανάπτυξη και δοκιμή

Δουλεύουμε στο minipc, δοκιμή από MacBook μέσω Tailscale:

```
npm run dev -- --host      # Astro
wrangler dev --ip 0.0.0.0  # Worker
```

## Ρίσκα, κατά σειρά σοβαρότητας

1. **Έγκριση API key από την ΚΥ ΓΕΜΗ.** Μπλοκάρει τα πάντα, άγνωστη διάρκεια, εκτός
   ελέγχου μας. Πρέπει να υποβληθεί πρώτο, πριν γραφτεί κώδικας.
2. **Σκαναρισμένα PDF.** Αν το δείγμα είναι κυρίως εικόνες, η ακρίβεια πέφτει δραματικά
   και το OCR γίνεται το κύριο πρόβλημα του project. Μετριασμός: `unparseable` αντί για
   μαντεψιά· απόφαση για OCR μετά το δείγμα.
3. **Ανομοιόμορφα formats ισολογισμών.** Τα ΕΛΠ επιτρέπουν πολλές μορφές, οι πολύ μικρές
   οντότητες δημοσιεύουν ελάχιστα. Μετριασμός: v1 μόνο ΑΕ/ΕΠΕ.
4. **Άγνωστα rate limits του ΓΕΜΗ.** Δεν τα ξέρουμε μέχρι να πάρουμε key. Μετριασμός:
   επιθετικό cache εξ αρχής.
5. **Υποχρέωση ODC-BY.** Αναφορά πηγής σε footer κάθε σελίδας και στο `/about`,
   από την πρώτη μέρα.

## Εκτός scope για το v1

- Οικονομικά για ατομικές επιχειρήσεις και ΟΕ/ΕΕ
- Σύγκριση εταιρειών, κλαδικοί δείκτες, γραφήματα τάσης
- Λογαριασμοί χρηστών, αγαπημένα, ειδοποιήσεις
- Διασύνδεση με ΑΑΔΕ ή VIES

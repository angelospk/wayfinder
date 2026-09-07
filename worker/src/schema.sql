-- Successful GEMI responses, kept as dated snapshots.
-- Never presented as live: every read carries fetched_at.
CREATE TABLE IF NOT EXISTS snapshots (
  resource_key   TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,          -- profile | documents | search
  ar_gemi        TEXT,
  payload        TEXT NOT NULL,          -- JSON as GEMI returned it
  fetched_at     INTEGER NOT NULL,       -- epoch ms
  refresh_due_at INTEGER NOT NULL,
  refresh_status TEXT NOT NULL DEFAULT 'fresh'  -- fresh | queued | failed
);
CREATE INDEX IF NOT EXISTS snapshots_ar_gemi ON snapshots (ar_gemi);
CREATE INDEX IF NOT EXISTS snapshots_refresh ON snapshots (refresh_due_at);

-- 404s and other definitive rejections, so a hostile or mistaken client
-- cannot spend the whole minute budget re-asking for a company that is absent.
CREATE TABLE IF NOT EXISTS negative (
  resource_key TEXT PRIMARY KEY,
  http_status  INTEGER NOT NULL,
  recorded_at  INTEGER NOT NULL,
  until        INTEGER NOT NULL
);

-- Extracted financial figures, written by the GitHub Actions parser.
CREATE TABLE IF NOT EXISTS financials (
  ar_gemi     TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ar_gemi, fiscal_year)
);

import { env } from "cloudflare:test";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  resource_key TEXT PRIMARY KEY, kind TEXT NOT NULL, ar_gemi TEXT,
  payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  refresh_due_at INTEGER NOT NULL, refresh_status TEXT NOT NULL DEFAULT 'fresh');
CREATE TABLE IF NOT EXISTS negative (
  resource_key TEXT PRIMARY KEY, http_status INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS financials (
  ar_gemi TEXT NOT NULL, fiscal_year INTEGER NOT NULL, payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (ar_gemi, fiscal_year));
`;

export async function applySchema() {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

export async function resetData() {
  await applySchema();
  for (const t of ["snapshots", "negative", "financials"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

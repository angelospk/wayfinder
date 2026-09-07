/**
 * Client for the wayfinder Worker.
 *
 * The Worker answers 202 while a company is still being fetched from ΓΕΜΗ,
 * because the registry allows the whole site 8 requests a minute. Callers are
 * expected to wait and ask again rather than treat 202 as an error.
 */
export const API_BASE = (import.meta.env.PUBLIC_API_BASE ?? "https://wayfinder.rovas450.workers.dev").replace(/\/$/, "");

export interface Meta {
  fetched_at?: number;
  state?: "queued" | "not_found" | "unavailable";
  queue_position?: number;
  eta_ms?: number;
  reason?: string;
  attribution?: string;
}

export interface Envelope<T> {
  data: T | null;
  meta: Meta;
  httpStatus: number;
}

async function get<T>(path: string): Promise<Envelope<T>> {
  const res = await fetch(API_BASE + path, { headers: { accept: "application/json" } });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { data: body.data ?? null, meta: body.meta ?? {}, httpStatus: res.status };
}

/** Ask repeatedly while the Worker reports the request is still queued. */
export async function getWithWait<T>(
  path: string,
  onWait: (meta: Meta) => void,
  timeoutMs = 120_000,
): Promise<Envelope<T>> {
  const deadline = Date.now() + timeoutMs;
  let attempt = await get<T>(path);
  while (attempt.httpStatus === 202 && Date.now() < deadline) {
    onWait(attempt.meta);
    const wait = Math.min(Math.max(attempt.meta.eta_ms ?? 5000, 2000), 15000);
    await new Promise((r) => setTimeout(r, wait));
    attempt = await get<T>(path);
  }
  return attempt;
}

export const search = (q: string) =>
  getWithWait<{ searchMetadata: { totalCount: number }; searchResults: Company[] }>(
    `/api/search?q=${encodeURIComponent(q)}`,
    () => {},
  );

export const company = (arGemi: string, onWait: (m: Meta) => void) =>
  getWithWait<Company>(`/api/company/${encodeURIComponent(arGemi)}`, onWait);

export const documents = (arGemi: string, onWait: (m: Meta) => void) =>
  getWithWait<DocumentList>(`/api/company/${encodeURIComponent(arGemi)}/documents`, onWait);

export const financials = (arGemi: string) =>
  get<Financials[]>(`/api/company/${encodeURIComponent(arGemi)}/financials`);

export interface Company {
  arGemi: string;
  afm: string | null;
  coNameEl: string;
  coTitlesEl?: string[];
  legalType?: { descr: string };
  status?: { descr: string };
  street?: string;
  streetNumber?: string;
  city?: string;
  zipCode?: string;
  prefecture?: { descr: string };
  gemiOffice?: { descr: string };
  incorporationDate?: string;
  url?: string | null;
  objective?: string | null;
  activities?: { activity: { id: string; descr: string }; isMain?: boolean }[];
}

export interface Filing {
  summary?: string;
  kak?: string;
  dateRegistrated?: string;
  decisionSubject?: string;
  assemblyDecisionUrl?: string;
}
export type DocumentList = Record<string, Filing[]>;

export interface Figure {
  value: number;
  source: "extracted" | "derived";
  page?: number;
  label_matched?: string;
}
export interface Financials {
  fiscal_year: number;
  status: string;
  reason?: string | null;
  unit_multiplier: number;
  figures: Record<string, Figure>;
  source_element_id?: string;
}

export function formatDate(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("el-GR", { day: "2-digit", month: "long", year: "numeric" });
}

export function formatMoney(v: number): string {
  return v.toLocaleString("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

export function elementIdOf(f: Filing): string | null {
  const m = (f.assemblyDecisionUrl ?? "").match(/[?&]elementId=(\d+)/);
  return m ? m[1] : null;
}

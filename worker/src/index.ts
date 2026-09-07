import { GemiDispatcher, type Ensure } from "./dispatcher";
import {
  normalizeArGemi,
  normalizeQuery,
  resourceKey,
  type Resource,
} from "./gemi";

export { GemiDispatcher };

interface Env {
  DB: D1Database;
  DISPATCHER: DurableObjectNamespace<GemiDispatcher>;
  GEMI_API_KEY: string;
  GEMI_BASE: string;
  REFRESH_AFTER_DAYS: string;
}

// Open data, read-only, no credentials: any origin may read it.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * A filing has to be buffered to be cached, and the Worker has 128 MB of
 * memory. Real ΓΕΜΗ filings run to a couple of megabytes; anything far past
 * that is a document we would rather send people to the registry for.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

const ATTRIBUTION =
  "Πηγή: Γ.Ε.ΜΗ. OpenData (opendata.businessportal.gr), ODC-BY-1.0";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...init.headers },
  });
}

/**
 * Every answer says when it was retrieved. This site serves dated snapshots of
 * the registry, not the registry, and saying otherwise would be a claim we
 * cannot support at six requests a minute.
 */
function envelope(result: Ensure, extra: Record<string, unknown> = {}): Response {
  switch (result.state) {
    case "done":
      return json({
        data: result.payload,
        meta: { fetched_at: result.fetchedAt, source: "gemi", attribution: ATTRIBUTION, ...extra },
      });
    case "pending":
      return json(
        {
          data: null,
          meta: {
            state: "queued",
            queue_position: result.queued,
            eta_ms: result.etaMs,
            attribution: ATTRIBUTION,
            ...extra,
          },
        },
        { status: 202, headers: { "retry-after": String(Math.ceil(result.etaMs / 1000) || 10) } },
      );
    case "absent":
      return json(
        { data: null, meta: { state: "not_found", http_status: result.httpStatus, until: result.until } },
        { status: 404 },
      );
    case "rejected":
      return json(
        { data: null, meta: { state: "unavailable", reason: result.reason } },
        {
          status: result.reason.startsWith("auth_") ? 503 : 503,
          headers: { "retry-after": String(Math.ceil(result.retryAfterMs / 1000) || 60) },
        },
      );
  }
}

function dispatcher(env: Env) {
  // One instance for the whole site: the rate limit is global, so the
  // coordinator has to be too.
  return env.DISPATCHER.get(env.DISPATCHER.idFromName("gemi-global"));
}

async function ensure(env: Env, resource: Resource): Promise<Ensure> {
  return await dispatcher(env).ensure(resourceKey(resource));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/health") {
      return json({ ok: true, attribution: ATTRIBUTION });
    }

    if (path === "/api/queue") {
      return json(await dispatcher(env).status());
    }

    if (path === "/api/search") {
      const q = normalizeQuery(url.searchParams.get("q") ?? "");
      if (q.length < 3) return json({ error: "query_too_short", min: 3 }, { status: 400 });
      const size = Math.min(Math.max(Number(url.searchParams.get("size") ?? 10) || 10, 1), 25);
      return envelope(await ensure(env, { kind: "search", q, size, offset: 0 }), { query: q });
    }

    const company = path.match(/^\/api\/company\/([^/]+)(?:\/(documents|financials|document))?(?:\/([^/]+))?$/);
    if (company) {
      const arGemi = normalizeArGemi(decodeURIComponent(company[1]));
      if (!arGemi) return json({ error: "bad_ar_gemi" }, { status: 400 });
      const section = company[2];

      if (!section) return envelope(await ensure(env, { kind: "profile", arGemi }));
      if (section === "documents") return envelope(await ensure(env, { kind: "documents", arGemi }));
      if (section === "financials") return await financials(env, arGemi);
      if (section === "document") return await document(env, arGemi, company[3], url);
    }

    return json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function financials(env: Env, arGemi: string): Promise<Response> {
  const rows = await env.DB
    .prepare("SELECT fiscal_year, payload, updated_at FROM financials WHERE ar_gemi = ? ORDER BY fiscal_year DESC")
    .bind(arGemi)
    .all<{ fiscal_year: number; payload: string; updated_at: number }>();
  return json({
    data: (rows.results ?? []).map((r) => ({
      fiscal_year: r.fiscal_year,
      updated_at: r.updated_at,
      ...JSON.parse(r.payload),
    })),
    meta: { attribution: ATTRIBUTION, note: "Επεξεργασία δικών μας εργαλείων από το επίσημο PDF" },
  });
}

/**
 * Serve a filing PDF.
 *
 * The elementId must appear in this company's own cached document list. Without
 * that check the route is an open, authenticated proxy to every file in GEMI,
 * paid for out of our six-per-minute budget.
 */
async function document(env: Env, arGemi: string, elementId: string | undefined, url: URL): Promise<Response> {
  if (!elementId || !/^\d{1,12}$/.test(elementId)) {
    return json({ error: "bad_element_id" }, { status: 400 });
  }
  const fileKey = url.searchParams.get("key") ?? "assemblyDecision";
  if (!/^[a-zA-Z]{1,40}$/.test(fileKey)) return json({ error: "bad_file_key" }, { status: 400 });

  const listed = await ensure(env, { kind: "documents", arGemi });
  if (listed.state !== "done") return envelope(listed);
  if (!documentBelongs(listed.payload, elementId)) {
    return json({ error: "document_not_in_company_filings" }, { status: 404 });
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://wayfinder.internal/doc/${fileKey}/${elementId}`);
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const upstream = await dispatcher(env).fetchFile(fileKey, elementId);
  if (!upstream.ok) {
    // Do not pass the upstream body or headers through: it may name GEMI
    // internals, and a 503 here means "we are pacing", not "GEMI said this".
    return json(
      { data: null, meta: { state: "unavailable", reason: `upstream_${upstream.status}` } },
      { status: 503, headers: { "retry-after": upstream.headers.get("retry-after") ?? "60" } },
    );
  }

  const declared = Number(upstream.headers.get("content-length") ?? 0);
  if (declared > MAX_PDF_BYTES) {
    return json({ error: "document_too_large", bytes: declared }, { status: 413 });
  }
  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_PDF_BYTES) {
    return json({ error: "document_too_large", bytes: body.byteLength }, { status: 413 });
  }
  const res = new Response(body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="gemi-${arGemi}-${elementId}.pdf"`,
      "cache-control": "public, max-age=604800",
      ...CORS,
    },
  });
  await cache.put(cacheKey, res.clone());
  return res;
}

function documentBelongs(payload: unknown, elementId: string): boolean {
  const doc = payload as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return false;
  for (const bucket of Object.values(doc)) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (!entry || typeof entry !== "object") continue;
      for (const value of Object.values(entry as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        if (value === elementId) return true;
        const m = value.match(/[?&]elementId=(\d+)/);
        if (m && m[1] === elementId) return true;
      }
    }
  }
  return false;
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

import { DurableObject } from "cloudflare:workers";
import {
  Resource,
  parseResourceKey,
  resourceKey,
  resourcePath,
} from "./gemi";

/**
 * The only code in the system that is allowed to call GEMI.
 *
 * GEMI gives the whole site 8 requests per minute. A token bucket of capacity 8
 * is not an 8-per-rolling-minute limit -- it can spend 8 immediately and 7 more
 * before the minute is up. So this paces instead: every outbound call waits at
 * least MIN_GAP_MS after the previous one, and a delay never accumulates credit
 * that could later be spent as a burst.
 *
 * The reservation is written to storage before the fetch. Cloudflare's output
 * gate holds the outgoing request until that write is confirmed, so a crash
 * between reserving and sending loses a slot rather than double-spending one.
 */
export const MIN_GAP_MS = 10_100;      // ~5.9 requests/minute, 8 allowed
export const COOLDOWN_429_MS = 90_000;
export const MAX_QUEUE = 200;
export const MAX_ATTEMPTS = 3;
export const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * RPC return values must be structured-clonable, which `unknown` is not, and a
 * recursive JSON type makes the RPC type machinery give up. GEMI always answers
 * with an object or an array, so `object` is both true and cheap to check.
 */
export type Payload = object;

export type Ensure =
  | { state: "done"; payload: Payload; fetchedAt: number }
  | { state: "pending"; queued: number; etaMs: number }
  | { state: "absent"; httpStatus: number; until: number }
  | { state: "rejected"; reason: string; retryAfterMs: number };

interface Env {
  DB: D1Database;
  GEMI_API_KEY: string;
  GEMI_BASE: string;
  REFRESH_AFTER_DAYS: string;
  /** Tests shrink the pace so they can prove the invariant in milliseconds. */
  MIN_GAP_MS?: string;
}

export class GemiDispatcher extends DurableObject<Env> {
  private sql: SqlStorage;
  private gap: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.gap = Number(env.MIN_GAP_MS ?? MIN_GAP_MS) || MIN_GAP_MS;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS pacing (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_allowed_at INTEGER NOT NULL DEFAULT 0,
          cooldown_until  INTEGER NOT NULL DEFAULT 0,
          paused_reason   TEXT
        );
        INSERT OR IGNORE INTO pacing (id, next_allowed_at, cooldown_until) VALUES (1, 0, 0);
        CREATE TABLE IF NOT EXISTS jobs (
          resource_key    TEXT PRIMARY KEY,
          created_at      INTEGER NOT NULL,
          next_attempt_at INTEGER NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 0,
          last_status     TEXT
        );
        CREATE TABLE IF NOT EXISTS negative (
          resource_key TEXT PRIMARY KEY,
          http_status  INTEGER NOT NULL,
          until        INTEGER NOT NULL
        );
      `);
    });
  }

  // ---------- pacing state ----------

  private pacing(): { next_allowed_at: number; cooldown_until: number; paused_reason: string | null } {
    return this.sql.exec("SELECT * FROM pacing WHERE id = 1").one() as any;
  }

  /** Reserve the next slot, or return null when the pace does not allow one yet. */
  private reserve(now: number): number | null {
    const p = this.pacing();
    if (p.paused_reason) return null;
    const earliest = Math.max(p.next_allowed_at, p.cooldown_until);
    if (now < earliest) return null;
    // Reserve from `now`, not from `earliest`: an idle hour must not become
    // credit for a burst.
    this.sql.exec("UPDATE pacing SET next_allowed_at = ? WHERE id = 1", now + this.gap);
    return now;
  }

  private waitMs(now: number): number {
    const p = this.pacing();
    return Math.max(0, Math.max(p.next_allowed_at, p.cooldown_until) - now);
  }

  // ---------- public entry points ----------

  async ensure(key: string, opts: { refresh?: boolean } = {}): Promise<Ensure> {
    const resource = parseResourceKey(key);
    if (!resource) return { state: "rejected", reason: "bad_resource_key", retryAfterMs: 0 };
    const now = Date.now();

    const neg = this.sql
      .exec("SELECT * FROM negative WHERE resource_key = ? AND until > ?", key, now)
      .toArray()[0] as any;
    if (neg) return { state: "absent", httpStatus: neg.http_status, until: neg.until };

    if (!opts.refresh) {
      const hit = await this.readSnapshot(key);
      if (hit) return { state: "done", payload: hit.payload, fetchedAt: hit.fetchedAt };
    }

    if (this.reserve(now) !== null) {
      const result = await this.attempt(resource, key);
      if (result) return result;
      // attempt() decided this needs another try later; fall through to queue.
    }

    return await this.enqueue(key, now);
  }

  /** Synchronous-only: PDFs are too large to sit in a queue or in D1. */
  async fetchFile(fileKey: string, elementId: string): Promise<Response> {
    const now = Date.now();
    if (this.reserve(now) === null) {
      return new Response("busy", {
        status: 503,
        headers: { "retry-after": String(Math.ceil(this.waitMs(now) / 1000)) },
      });
    }
    const r: Resource = { kind: "file", fileKey, elementId };
    const upstream = await this.call(resourcePath(r));
    if (upstream.status === 429) {
      this.cooldown(upstream);
      return new Response("upstream rate limited", { status: 503, headers: { "retry-after": "90" } });
    }
    return upstream;
  }

  async status(): Promise<object> {
    const now = Date.now();
    const p = this.pacing();
    const queued = (this.sql.exec("SELECT COUNT(*) AS n FROM jobs").one() as any).n;
    return {
      queued,
      nextSlotInMs: this.waitMs(now),
      cooldownUntil: p.cooldown_until,
      pausedReason: p.paused_reason,
      minGapMs: this.gap,
    };
  }

  // ---------- queue ----------

  private async enqueue(key: string, now: number): Promise<Ensure> {
    const queued = (this.sql.exec("SELECT COUNT(*) AS n FROM jobs").one() as any).n as number;
    const existing = this.sql
      .exec("SELECT * FROM jobs WHERE resource_key = ?", key)
      .toArray()[0] as any;
    if (!existing) {
      if (queued >= MAX_QUEUE) {
        return { state: "rejected", reason: "queue_full", retryAfterMs: 60_000 };
      }
      this.sql.exec(
        "INSERT INTO jobs (resource_key, created_at, next_attempt_at) VALUES (?, ?, ?)",
        key, now, now,
      );
    }
    await this.armAlarm();
    const position = (this.sql.exec(
      "SELECT COUNT(*) AS n FROM jobs WHERE created_at <= (SELECT created_at FROM jobs WHERE resource_key = ?)",
      key,
    ).one() as any).n as number;
    return { state: "pending", queued: position, etaMs: this.waitMs(now) + (position - 1) * this.gap };
  }

  private async armAlarm(): Promise<void> {
    const next = this.sql
      .exec("SELECT MIN(next_attempt_at) AS t FROM jobs")
      .one() as any;
    if (next.t == null) return;
    const at = Math.max(next.t as number, Date.now() + this.waitMs(Date.now()));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.reserve(now) !== null) {
      const job = this.sql
        .exec("SELECT * FROM jobs WHERE next_attempt_at <= ? ORDER BY created_at LIMIT 1", now)
        .toArray()[0] as any;
      if (job) {
        const resource = parseResourceKey(job.resource_key);
        // Re-check the cache: another path may have filled it since we queued.
        const hit = resource ? await this.readSnapshot(job.resource_key) : null;
        if (hit || !resource) {
          this.sql.exec("DELETE FROM jobs WHERE resource_key = ?", job.resource_key);
        } else {
          await this.attempt(resource, job.resource_key, job);
        }
      }
    }
    const remaining = this.sql.exec("SELECT MIN(next_attempt_at) AS t FROM jobs").one() as any;
    if (remaining.t != null) {
      await this.ctx.storage.setAlarm(Date.now() + Math.max(this.waitMs(Date.now()), 50));
    }
  }

  // ---------- the actual call ----------

  private call(path: string): Promise<Response> {
    return fetch(this.env.GEMI_BASE + path, {
      headers: { api_key: this.env.GEMI_API_KEY, accept: "application/json" },
      redirect: "manual", // a followed redirect would be a second unmetered call
    });
  }

  private cooldown(res: Response): void {
    const retryAfter = Number(res.headers.get("retry-after"));
    const ms = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000 + 5_000
      : COOLDOWN_429_MS;
    this.sql.exec("UPDATE pacing SET cooldown_until = ? WHERE id = 1", Date.now() + ms);
  }

  /**
   * Spend the reserved slot. Returns a terminal Ensure, or null when the caller
   * should queue the work for another try.
   */
  private async attempt(resource: Resource, key: string, job?: any): Promise<Ensure | null> {
    let res: Response;
    try {
      res = await this.call(resourcePath(resource));
    } catch {
      return this.retryOrGiveUp(key, job, "network");
    }

    if (res.status === 429) {
      this.cooldown(res);
      return null; // not the job's fault: keep it, do not consume an attempt
    }
    if (res.status === 401 || res.status === 403) {
      this.sql.exec("UPDATE pacing SET paused_reason = ? WHERE id = 1", `auth_${res.status}`);
      return { state: "rejected", reason: `auth_${res.status}`, retryAfterMs: 0 };
    }
    if (res.status === 404) {
      const until = Date.now() + NEGATIVE_TTL_MS;
      this.sql.exec(
        "INSERT OR REPLACE INTO negative (resource_key, http_status, until) VALUES (?, 404, ?)",
        key, until,
      );
      this.sql.exec("DELETE FROM jobs WHERE resource_key = ?", key);
      return { state: "absent", httpStatus: 404, until };
    }
    if (!res.ok) {
      return this.retryOrGiveUp(key, job, `http_${res.status}`);
    }

    let payload: Payload;
    try {
      payload = await res.json();
      if (payload === null || typeof payload !== "object") throw new Error("not an object");
    } catch {
      return this.retryOrGiveUp(key, job, "bad_json");
    }

    const fetchedAt = Date.now();
    await this.writeSnapshot(key, resource, payload, fetchedAt);
    this.sql.exec("DELETE FROM jobs WHERE resource_key = ?", key);
    return { state: "done", payload, fetchedAt };
  }

  private retryOrGiveUp(key: string, job: any, status: string): Ensure | null {
    const attempts = (job?.attempts ?? 0) + 1;
    const now = Date.now();
    if (attempts >= MAX_ATTEMPTS) {
      this.sql.exec("DELETE FROM jobs WHERE resource_key = ?", key);
      return { state: "rejected", reason: status, retryAfterMs: NEGATIVE_TTL_MS };
    }
    const backoff = 2 ** attempts * 30_000 + Math.floor(Math.random() * 5_000);
    this.sql.exec(
      `INSERT INTO jobs (resource_key, created_at, next_attempt_at, attempts, last_status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (resource_key) DO UPDATE SET
         next_attempt_at = excluded.next_attempt_at,
         attempts = excluded.attempts,
         last_status = excluded.last_status`,
      key, now, now + backoff, attempts, status,
    );
    return null;
  }

  // ---------- D1 snapshots ----------

  private refreshAfterMs(): number {
    return Number(this.env.REFRESH_AFTER_DAYS ?? 30) * 86_400_000;
  }

  private async readSnapshot(key: string) {
    const row = await this.env.DB
      .prepare("SELECT payload, fetched_at FROM snapshots WHERE resource_key = ?")
      .bind(key)
      .first<{ payload: string; fetched_at: number }>();
    if (!row) return null;
    return { payload: JSON.parse(row.payload), fetchedAt: row.fetched_at };
  }

  private async writeSnapshot(key: string, resource: Resource, payload: Payload, at: number) {
    const arGemi = "arGemi" in resource ? resource.arGemi : null;
    const stmts: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO snapshots (resource_key, kind, ar_gemi, payload, fetched_at, refresh_due_at, refresh_status)
         VALUES (?, ?, ?, ?, ?, ?, 'fresh')
         ON CONFLICT (resource_key) DO UPDATE SET
           payload = excluded.payload,
           fetched_at = excluded.fetched_at,
           refresh_due_at = excluded.refresh_due_at,
           refresh_status = 'fresh'`,
      ).bind(key, resource.kind, arGemi, JSON.stringify(payload), at, at + this.refreshAfterMs()),
    ];
    // A search response carries whole company profiles. Warming them here is
    // the only way this site ever gets ahead of a 6-per-minute budget.
    if (resource.kind === "search" && payload && typeof payload === "object") {
      const results = (payload as any).searchResults;
      if (Array.isArray(results)) {
        for (const c of results.slice(0, 50)) {
          const ar = String(c?.arGemi ?? "").replace(/\D/g, "").padStart(12, "0");
          if (ar.length !== 12) continue;
          stmts.push(
            this.env.DB.prepare(
              `INSERT INTO snapshots (resource_key, kind, ar_gemi, payload, fetched_at, refresh_due_at, refresh_status)
               VALUES (?, 'profile', ?, ?, ?, ?, 'fresh')
               ON CONFLICT (resource_key) DO UPDATE SET
                 payload = excluded.payload,
                 fetched_at = excluded.fetched_at,
                 refresh_due_at = excluded.refresh_due_at`,
            ).bind(
              resourceKey({ kind: "profile", arGemi: ar }), ar,
              JSON.stringify(c), at, at + this.refreshAfterMs(),
            ),
          );
        }
      }
    }
    await this.env.DB.batch(stmts);
  }
}

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resourceKey } from "../src/gemi";
import { resetData } from "./apply-schema";
import { attempts, control, resetAttempts } from "./origin";

const GAP = Number((env as any).MIN_GAP_MS ?? 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Each test gets its own dispatcher and its own block of company numbers.
 *
 * Tests share one mock origin, and a queued job from an earlier test can fire
 * its alarm in the middle of a later one. Scoping the assertions to this test's
 * own companies is what makes "how many requests left the isolate" answerable.
 */
let tag = 0;
function scope() {
  const prefix = String(++tag).padStart(3, "0");
  return {
    dispatcher: env.DISPATCHER.get(env.DISPATCHER.idFromName(`d-${prefix}-${Date.now()}`)),
    profile: (n: number) =>
      resourceKey({ kind: "profile", arGemi: prefix + String(n).padStart(9, "0") }),
    mine: () => attempts(`/companies/${prefix}`),
  };
}

beforeEach(async () => {
  await control();
  await resetData();
});

describe("deduplication", () => {
  it("turns 50 concurrent requests for one company into one call to GEMI", async () => {
    const { dispatcher, profile, mine } = scope();
    const results = await Promise.all(Array.from({ length: 50 }, () => dispatcher.ensure(profile(1))));

    expect((await mine()).length).toBe(1);
    expect(results.some((r) => r.state === "done")).toBe(true);
    for (const r of results) expect(["done", "pending"]).toContain(r.state);
  });

  it("serves the second request from the snapshot without touching GEMI", async () => {
    const { dispatcher, profile, mine } = scope();
    expect((await dispatcher.ensure(profile(2))).state).toBe("done");
    await resetAttempts();

    expect((await dispatcher.ensure(profile(2))).state).toBe("done");
    expect((await mine()).length).toBe(0);
  });
});

describe("pacing", () => {
  it("never sends two requests closer together than the configured gap", async () => {
    const { dispatcher, profile, mine } = scope();
    for (let i = 0; i < 6; i++) {
      await dispatcher.ensure(profile(i));
      await sleep(GAP + 20);
    }

    const log = await mine();
    expect(log.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < log.length; i++) {
      // 10ms of slack for clock granularity inside the isolate.
      expect(log[i].at - log[i - 1].at).toBeGreaterThanOrEqual(GAP - 10);
    }
  });

  it("does not turn an idle period into a burst", async () => {
    const { dispatcher, profile, mine } = scope();
    await dispatcher.ensure(profile(10));
    await sleep(GAP * 6);
    await resetAttempts();

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => dispatcher.ensure(profile(100 + i))),
    );

    expect((await mine()).length).toBe(1);
    expect(results.filter((r) => r.state === "pending").length).toBe(5);
  });
});

describe("failure handling", () => {
  it("stops all traffic after a 429 instead of retrying into the limit", async () => {
    await control({ status: 429, body: "slow down", headers: { "retry-after": "1" } });
    const { dispatcher, profile, mine } = scope();

    await dispatcher.ensure(profile(200));
    expect((await mine()).length).toBe(1);
    await resetAttempts();

    for (let i = 0; i < 3; i++) {
      await dispatcher.ensure(profile(300 + i));
      await sleep(GAP + 20);
    }
    expect((await mine()).length).toBe(0);
    expect(((await dispatcher.status()) as any).cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("remembers a 404 so repeated visitors cannot spend the budget on it", async () => {
    await control({ status: 404, body: { error: "not found" } });
    const { dispatcher, profile, mine } = scope();

    expect((await dispatcher.ensure(profile(404))).state).toBe("absent");
    await resetAttempts();

    for (let i = 0; i < 5; i++) {
      expect((await dispatcher.ensure(profile(404))).state).toBe("absent");
    }
    expect((await mine()).length).toBe(0);
  });

  it("pauses dispatch entirely when the API key is rejected", async () => {
    await control({ status: 401, body: { error: "unauthorized" } });
    const { dispatcher, profile, mine } = scope();

    expect((await dispatcher.ensure(profile(401))).state).toBe("rejected");
    await resetAttempts();
    await sleep(GAP + 20);

    await dispatcher.ensure(profile(402));
    expect((await mine()).length).toBe(0);
    expect(((await dispatcher.status()) as any).pausedReason).toBe("auth_401");
  });
});

describe("search warms profiles", () => {
  it("stores every company a search returned, so the next lookup is free", async () => {
    await control({
      body: {
        searchMetadata: { totalCount: 2 },
        searchResults: [
          { arGemi: "54414421000", coNameEl: "A" },
          { arGemi: "113772252000", coNameEl: "B" },
        ],
      },
    });
    const { dispatcher } = scope();

    await dispatcher.ensure(resourceKey({ kind: "search", q: "ΤΕΣΤ", size: 10, offset: 0 }));
    await resetAttempts();

    const hit = await dispatcher.ensure(resourceKey({ kind: "profile", arGemi: "054414421000" }));
    expect(hit.state).toBe("done");
    expect((await attempts("054414421000")).length).toBe(0);
  });
});

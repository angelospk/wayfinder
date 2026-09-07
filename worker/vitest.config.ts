import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * A recording stand-in for GEMI.
 *
 * Every fetch the Worker makes is routed here, so the tests assert on the
 * requests that actually left the isolate rather than on the dispatcher's own
 * bookkeeping. A limiter that miscounts would still pass a counter assertion.
 */
function mockOrigin() {
  let attempts: { path: string; at: number }[] = [];
  let status = 200;
  let body: string = JSON.stringify({ ok: true });
  let headers: Record<string, string> = {};

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/__attempts") {
      return Response.json(attempts);
    }
    if (url.pathname === "/__reset") {
      attempts = [];
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__control") {
      attempts = [];
      status = Number(url.searchParams.get("status") ?? 200);
      body = url.searchParams.get("body") ?? JSON.stringify({ ok: true });
      headers = JSON.parse(url.searchParams.get("headers") ?? "{}");
      return Response.json({ ok: true });
    }
    attempts.push({ path: url.pathname + url.search, at: Date.now() });
    return new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
}

export default defineConfig({
  // The mock origin above is one shared, mutable recorder. Two test files
  // running at once would clear each other's recorded requests.
  test: { fileParallelism: false },
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          GEMI_API_KEY: "test-key",
          GEMI_BASE: "https://gemi.test/api/opendata/v1",
          // Shrunk so the pacing invariant can be proven in milliseconds.
          MIN_GAP_MS: "120",
          REFRESH_AFTER_DAYS: "30",
        },
        d1Databases: { DB: "wayfinder-test" },
        outboundService: mockOrigin(),
      },
    }),
  ],
});

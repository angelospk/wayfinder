/** Talk to the recording mock origin configured in vitest.config.ts. */
export interface Attempt { path: string; at: number }

export async function control(opts: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const p = new URLSearchParams();
  p.set("status", String(opts.status ?? 200));
  p.set("body", typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? { ok: true }));
  p.set("headers", JSON.stringify(opts.headers ?? {}));
  await fetch(`https://gemi.test/__control?${p}`);
}

export async function attempts(match?: string): Promise<Attempt[]> {
  const res = await fetch("https://gemi.test/__attempts");
  const all: Attempt[] = await res.json();
  return match ? all.filter((a) => a.path.includes(match)) : all;
}

/** Clear the recorded attempts without changing what the origin replies. */
export async function resetAttempts() {
  await fetch("https://gemi.test/__reset");
}

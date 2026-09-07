/**
 * The GEMI OpenData surface, and the canonical key for every resource on it.
 *
 * A resource key is the single identity used by the cache, the queue and the
 * in-flight table. Two requests that share a key must never become two calls
 * to GEMI: at 6 calls a minute, a duplicate is a minute someone else waits.
 */
export const SCHEMA_VERSION = "v1";

export type Kind = "profile" | "documents" | "search" | "file";

export type Resource =
  | { kind: "profile"; arGemi: string }
  | { kind: "documents"; arGemi: string }
  | { kind: "search"; q: string; size: number; offset: number }
  | { kind: "file"; fileKey: string; elementId: string };

export function normalizeArGemi(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 12) return null;
  return digits.padStart(12, "0");
}

export function normalizeQuery(raw: string): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/ς/gi, "Σ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function resourceKey(r: Resource): string {
  switch (r.kind) {
    case "profile":
      return `${SCHEMA_VERSION}|profile|${r.arGemi}`;
    case "documents":
      return `${SCHEMA_VERSION}|documents|${r.arGemi}`;
    case "search":
      return `${SCHEMA_VERSION}|search|${r.q}|${r.size}|${r.offset}`;
    case "file":
      return `${SCHEMA_VERSION}|file|${r.fileKey}|${r.elementId}`;
  }
}

/** The path and query GEMI expects, derived only from a validated Resource. */
export function resourcePath(r: Resource): string {
  switch (r.kind) {
    case "profile":
      return `/companies/${encodeURIComponent(r.arGemi)}`;
    case "documents":
      return `/companies/${encodeURIComponent(r.arGemi)}/documents`;
    case "search": {
      const p = new URLSearchParams({
        name: r.q,
        resultsSize: String(r.size),
        resultsOffset: String(r.offset),
      });
      return `/companies?${p}`;
    }
    case "file": {
      const p = new URLSearchParams({ key: r.fileKey, elementId: r.elementId });
      return `/downloadFile?${p}`;
    }
  }
}

export function parseResourceKey(key: string): Resource | null {
  const parts = key.split("|");
  if (parts[0] !== SCHEMA_VERSION) return null;
  switch (parts[1]) {
    case "profile":
      return parts.length === 3 ? { kind: "profile", arGemi: parts[2] } : null;
    case "documents":
      return parts.length === 3 ? { kind: "documents", arGemi: parts[2] } : null;
    case "search":
      return parts.length === 5
        ? { kind: "search", q: parts[2], size: Number(parts[3]), offset: Number(parts[4]) }
        : null;
    case "file":
      return parts.length === 4
        ? { kind: "file", fileKey: parts[2], elementId: parts[3] }
        : null;
    default:
      return null;
  }
}

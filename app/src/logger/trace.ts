// src/logger/trace.ts — short trace IDs to correlate logs across an
// end-to-end conversation turn (chat → bus → core → provider → stream → SSE).
//
// Format: 8 hex chars (e.g. "a3f10b9c"). Long enough to disambiguate within
// a session, short enough to be readable in logs. Generated from crypto.randomUUID
// (no extra dependency).

export function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Truncate string for log previews. Adds … if cut. */
export function preview(s: string | undefined, max = 120): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

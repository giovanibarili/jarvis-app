/**
 * Per-API-call usage log.
 *
 * Writes one JSON object per line ("JSONL") to `app/.jarvis/logs/usage.log`.
 * Every Anthropic API response that carries `message.usage` is appended,
 * regardless of which session triggered it. Intent: provide a flat,
 * grep/jq-friendly trail to analyse token consumption per session, model,
 * and time window — purely for cost / efficiency analysis.
 *
 * Failure mode: any I/O error is swallowed silently. The log MUST NEVER
 * break a live AI session.
 *
 * Format (one line):
 *   {
 *     "ts": "2026-04-28T12:34:56.789Z",
 *     "sessionId": "main",
 *     "model": "claude-sonnet-4-5-20250929",
 *     "input_tokens": 1234,
 *     "output_tokens": 567,
 *     "cache_creation_input_tokens": 0,
 *     "cache_read_input_tokens": 12000,
 *     "total_input": 13234,
 *     "total": 13801,
 *     "iterations": 1
 *   }
 *
 * `total_input` = input + cache_creation + cache_read (everything billed
 * on the input side). `total` = total_input + output. `iterations` may be
 * absent when not provided by the caller.
 *
 * No log rotation here — the file grows append-only. Use external tooling
 * (logrotate, manual rm, etc.) if it ever gets too big. A typical day
 * generates a few hundred KB at worst, so it's a non-issue for now.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const USAGE_LOG_DIR = join(process.cwd(), ".jarvis", "logs");
const USAGE_LOG_FILE = process.env.JARVIS_USAGE_LOG_FILE ?? join(USAGE_LOG_DIR, "usage.log");

let initialized = false;

function ensureDir(): void {
  if (initialized) return;
  try {
    mkdirSync(USAGE_LOG_DIR, { recursive: true });
    initialized = true;
  } catch {
    // ignore — appendFileSync will fail later if dir really can't be made
  }
}

export interface UsageLogEntry {
  sessionId: string;
  instanceId?: string;
  effort?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  iterations?: number;
}

/**
 * Append a usage entry to the JSONL log. Synchronous on purpose —
 * usage events are infrequent (once per API response) and we want
 * the line to land before any subsequent crash. Errors are swallowed.
 */
export function logUsage(entry: UsageLogEntry): void {
  ensureDir();
  const total_input =
    (entry.input_tokens ?? 0) +
    (entry.cache_creation_input_tokens ?? 0) +
    (entry.cache_read_input_tokens ?? 0);
  const total = total_input + (entry.output_tokens ?? 0);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    sessionId: entry.sessionId,
    ...(entry.instanceId !== undefined ? { instanceId: entry.instanceId } : {}),
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
    model: entry.model,
    input_tokens: entry.input_tokens,
    output_tokens: entry.output_tokens,
    cache_creation_input_tokens: entry.cache_creation_input_tokens,
    cache_read_input_tokens: entry.cache_read_input_tokens,
    total_input,
    total,
    ...(entry.iterations !== undefined ? { iterations: entry.iterations } : {}),
  }) + "\n";
  try {
    appendFileSync(USAGE_LOG_FILE, line, { encoding: "utf8" });
  } catch {
    // never break the session because of a log write
  }
}

export const USAGE_LOG_PATH = USAGE_LOG_FILE;

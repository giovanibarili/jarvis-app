import pino from "pino";

export type LogEntry = {
  seq: number;
  timestamp: string;
  level: string;
  msg: string;
};

const MAX_BUFFER = 500;
const logBuffer: LogEntry[] = [];
const listeners: Set<(entry: LogEntry) => void> = new Set();
let nextSeq = 0;

function pushEntry(entry: LogEntry) {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  for (const fn of listeners) fn(entry);
}

export function getLogBuffer(): LogEntry[] {
  return [...logBuffer];
}

export function onLogEntry(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

import { mkdirSync, existsSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Always write logs to file
const LOG_DIR = join(process.cwd(), ".jarvis", "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = process.env.JARVIS_LOG_FILE ?? join(LOG_DIR, "jarvis.log");

// Rotate on startup: rename current log to timestamped file, keep last 3
const MAX_LOG_FILES = 3;
if (existsSync(LOG_FILE)) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rotated = join(LOG_DIR, `jarvis-${ts}.log`);
  try {
    renameSync(LOG_FILE, rotated);
  } catch { /* ignore — file may be locked briefly */ }

  // Prune old rotated logs, keep only MAX_LOG_FILES most recent
  try {
    const rotatedFiles = readdirSync(LOG_DIR)
      .filter(f => f.startsWith("jarvis-") && f.endsWith(".log"))
      .sort()
      .reverse();
    for (const f of rotatedFiles.slice(MAX_LOG_FILES)) {
      unlinkSync(join(LOG_DIR, f));
    }
  } catch { /* best effort */ }
}

const consoleLevel = process.env.LOG_LEVEL ?? "silent";

const destination = pino.transport({
  targets: [
    // Always write to file
    { target: "pino-pretty", options: { colorize: false, destination: LOG_FILE }, level: "debug" },
    // Console only if LOG_LEVEL is set
    ...(consoleLevel !== "silent"
      ? [{ target: "pino-pretty", options: { colorize: true }, level: consoleLevel }]
      : []),
  ],
});

// The actual pino logger — always writes to file, optionally to console
const pinoLogger = pino({ level: "debug" }, destination);

// Proxy that intercepts log calls to also push to the in-memory buffer
export const log = new Proxy(pinoLogger, {
  get(target, prop, receiver) {
    const val = Reflect.get(target, prop, receiver);
    if (typeof prop === "string" && ["trace", "debug", "info", "warn", "error", "fatal"].includes(prop)) {
      return (...args: any[]) => {
        // Extract message from pino's calling convention
        const msg = typeof args[0] === "string" ? args[0]
          : typeof args[1] === "string" ? args[1]
          : String(args[0]);

        pushEntry({
          seq: nextSeq++,
          timestamp: new Date().toISOString(),
          level: prop,
          msg,
        });

        return (val as Function).apply(target, args);
      };
    }
    return val;
  },
});

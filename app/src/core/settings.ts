// src/core/settings.ts
// Two-layer settings: default (committed) + user (local, gitignored)
// load() merges them: user overrides default. save() writes to user only.
// Uses in-memory cache with mtime check — avoids re-reading disk on every call.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger/index.js";

export interface PieceSettings {
  enabled: boolean;
  visible: boolean;
}

export interface PieceConfig {
  [key: string]: unknown;
}

export interface PluginSettings {
  repo: string;
  path: string;
  enabled: boolean;
  branch: string;
}

export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
}

export interface CompactionSettings {
  enabled: boolean;
  thresholdPercent: number;
  instructions: string;
  pauseAfterCompaction: boolean;
}

export interface Settings {
  pieces: Record<string, PieceSettings & { config?: PieceConfig }>;
  plugins?: Record<string, PluginSettings>;
  providers?: Record<string, ProviderSettings>;
  model?: string;
  compaction?: CompactionSettings;
  theme?: string; // active theme name (maps to ~/.jarvis/themes/<name>/theme.json)
}

const SETTINGS_DIR = join(process.cwd(), ".jarvis");
const DEFAULT_PATH = join(SETTINGS_DIR, "settings.json");
const USER_PATH = join(SETTINGS_DIR, "settings.user.json");

const PROTECTED_PIECES = new Set(["jarvis-core", "capability-executor", "capability-loader", "chat"]);

export function isProtected(pieceId: string): boolean {
  return PROTECTED_PIECES.has(pieceId);
}

export function getDefault(): PieceSettings {
  return { enabled: true, visible: true };
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Avoids re-reading and re-parsing JSON on every load() call.
// Validates cache using file mtime — if disk changed, re-reads.

interface SettingsCache {
  settings: Settings;
  defaultMtime: number;
  userMtime: number;
}

let cache: SettingsCache | null = null;

function getMtime(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function loadFile(path: string): Settings {
  try {
    if (!existsSync(path)) return { pieces: {} };
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as Settings;
  } catch {
    return { pieces: {} };
  }
}

const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  thresholdPercent: 83.5,
  instructions: "Preserve capability names, tool call results, actor pool state, code snippets, and design decisions. Summarize verbose tool outputs and intermediate reasoning. Keep track of what the user asked for and current progress.",
  pauseAfterCompaction: true,
};

function deepMerge(base: Settings, override: Settings): Settings {
  return {
    pieces: { ...base.pieces, ...override.pieces },
    plugins: { ...base.plugins, ...override.plugins },
    providers: { ...base.providers, ...override.providers },
    model: override.model ?? base.model,
    compaction: override.compaction
      ? { ...DEFAULT_COMPACTION, ...base.compaction, ...override.compaction }
      : base.compaction,
    theme: override.theme ?? base.theme,
  };
}

export function load(): Settings {
  const defaultMtime = getMtime(DEFAULT_PATH);
  const userMtime = getMtime(USER_PATH);

  if (cache && cache.defaultMtime === defaultMtime && cache.userMtime === userMtime) {
    return cache.settings;
  }

  const defaults = loadFile(DEFAULT_PATH);
  const user = loadFile(USER_PATH);
  const merged = deepMerge(defaults, user);

  cache = { settings: merged, defaultMtime, userMtime };

  log.debug({
    defaultPath: DEFAULT_PATH,
    userPath: USER_PATH,
    hasUser: existsSync(USER_PATH),
    pieceCount: Object.keys(merged.pieces).length,
    cacheHit: false,
  }, "Settings: loaded from disk");

  return merged;
}

/** Invalidate in-memory cache — forces next load() to re-read from disk */
export function invalidateCache(): void {
  cache = null;
}

export function save(settings: Settings): void {
  try {
    if (!existsSync(SETTINGS_DIR)) {
      mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    // Always save to user file — default is committed to repo
    writeFileSync(USER_PATH, JSON.stringify(settings, null, 2) + "\n");
    // Update cache immediately so subsequent load() sees the new state
    // without waiting for the next mtime check
    const defaultMtime = getMtime(DEFAULT_PATH);
    const userMtime = getMtime(USER_PATH);
    cache = { settings, defaultMtime, userMtime };
    log.debug({ path: USER_PATH }, "Settings: saved (user)");
  } catch (err) {
    log.error({ err }, "Settings: failed to save");
  }
}

export function getCompactionSettings(settings: Settings): CompactionSettings {
  return { ...DEFAULT_COMPACTION, ...settings.compaction };
}

export function getPieceSettings(settings: Settings, pieceId: string): PieceSettings {
  return settings.pieces[pieceId] ?? getDefault();
}

export function setPieceSettings(settings: Settings, pieceId: string, update: Partial<PieceSettings>): Settings {
  const current = getPieceSettings(settings, pieceId);
  settings.pieces[pieceId] = { ...current, ...update };
  return settings;
}

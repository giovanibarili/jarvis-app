// src/core/settings.ts
// Two-layer settings: default (committed) + user (local, gitignored)
// load() merges them: user overrides default. save() writes to user only.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

export interface Settings {
  pieces: Record<string, PieceSettings & { config?: PieceConfig }>;
  plugins?: Record<string, PluginSettings>;
  providers?: Record<string, ProviderSettings>;
  model?: string;
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

function loadFile(path: string): Settings {
  try {
    if (!existsSync(path)) return { pieces: {} };
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as Settings;
  } catch {
    return { pieces: {} };
  }
}

function deepMerge(base: Settings, override: Settings): Settings {
  return {
    pieces: { ...base.pieces, ...override.pieces },
    plugins: { ...base.plugins, ...override.plugins },
    providers: { ...base.providers, ...override.providers },
    model: override.model ?? base.model,
  };
}

export function load(): Settings {
  const defaults = loadFile(DEFAULT_PATH);
  const user = loadFile(USER_PATH);
  const merged = deepMerge(defaults, user);
  log.info({
    defaultPath: DEFAULT_PATH,
    userPath: USER_PATH,
    hasUser: existsSync(USER_PATH),
    pieceCount: Object.keys(merged.pieces).length,
  }, "Settings: loaded");
  return merged;
}

export function save(settings: Settings): void {
  try {
    if (!existsSync(SETTINGS_DIR)) {
      mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    // Always save to user file — default is committed to repo
    writeFileSync(USER_PATH, JSON.stringify(settings, null, 2) + "\n");
    log.debug({ path: USER_PATH }, "Settings: saved (user)");
  } catch (err) {
    log.error({ err }, "Settings: failed to save");
  }
}

export function getPieceSettings(settings: Settings, pieceId: string): PieceSettings {
  return settings.pieces[pieceId] ?? getDefault();
}

export function setPieceSettings(settings: Settings, pieceId: string, update: Partial<PieceSettings>): Settings {
  const current = getPieceSettings(settings, pieceId);
  settings.pieces[pieceId] = { ...current, ...update };
  return settings;
}

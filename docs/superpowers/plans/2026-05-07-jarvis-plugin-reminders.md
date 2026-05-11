# jarvis-plugin-reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `jarvis-plugin-reminders` — a JARVIS plugin that lets the LLM and user create reminders injected into the system prompt on each turn, with configurable trigger, scope, format, and keyword gating policies.

**Architecture:** Plugin follows the standard JARVIS plugin pattern (`plugin.json` + `pieces/` + `renderers/`). Core is split into three layers: `reminder-store.ts` (disk I/O via `gray-matter`), `reminder-engine.ts` (pure matching/render functions), and `reminder-piece.ts` (Piece orchestrator: bus, capabilities, HTTP, HUD). The React renderer lives in `renderers/ReminderRenderer.tsx`.

**Tech Stack:** TypeScript, gray-matter (YAML frontmatter), React (injected via `window.__JARVIS_REACT` — no import), JARVIS plugin API (`@jarvis/core` types)

**Spec:** `docs/superpowers/specs/2026-05-07-jarvis-plugin-reminders-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `~/.jarvis/plugins/jarvis-plugin-reminders/plugin.json` | Create | Plugin manifest |
| `~/.jarvis/plugins/jarvis-plugin-reminders/package.json` | Create | Deps: gray-matter |
| `~/.jarvis/plugins/jarvis-plugin-reminders/CODEOWNERS` | Create | Ownership |
| `~/.jarvis/plugins/jarvis-plugin-reminders/README.md` | Create | User docs |
| `~/.jarvis/plugins/jarvis-plugin-reminders/context.md` | Create | Static LLM instructions for tools |
| `~/.jarvis/plugins/jarvis-plugin-reminders/functional-test.md` | Create | 20 BDD scenarios |
| `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/index.ts` | Create | `createPieces(ctx)` entry |
| `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/types.ts` | Create | `Reminder`, `Trigger`, `Scope`, `Format`, `Gating` |
| `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-store.ts` | Create | Disk I/O: load/save/delete markdown files |
| `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-engine.ts` | Create | Pure functions: match + render |
| `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-piece.ts` | Create | Full Piece: lifecycle, capabilities, HTTP, HUD |
| `~/.jarvis/plugins/jarvis-plugin-reminders/renderers/ReminderRenderer.tsx` | Create | React HUD panel + filter + cards + form |

---

## Task 1: Scaffold — plugin manifest + deps

**Files:**
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/plugin.json`
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/package.json`
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/CODEOWNERS`

- [ ] **Step 1: Create plugin directory**

```bash
mkdir -p ~/.jarvis/plugins/jarvis-plugin-reminders/pieces
mkdir -p ~/.jarvis/plugins/jarvis-plugin-reminders/renderers
```

Expected: directories created, no error.

- [ ] **Step 2: Write plugin.json**

```json
{
  "name": "jarvis-plugin-reminders",
  "version": "0.1.0",
  "description": "Configurable reminders injected into the system prompt — create rules, context anchors, and nudges with trigger/scope/format/gating policies.",
  "author": "giovanibarili",
  "entry": "pieces/index.ts",
  "capabilities": {
    "pieces": true,
    "renderers": true
  }
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/plugin.json`

- [ ] **Step 3: Write package.json**

```json
{
  "name": "jarvis-plugin-reminders",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "gray-matter": "^4.0.3"
  }
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/package.json`

- [ ] **Step 4: Write CODEOWNERS**

```
* @giovanibarili
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/CODEOWNERS`

- [ ] **Step 5: Install dependencies**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-reminders && npm install
```

Expected: `node_modules/gray-matter` present. `package-lock.json` created.

- [ ] **Step 6: Verify scaffold**

```bash
ls ~/.jarvis/plugins/jarvis-plugin-reminders/
```

Expected output contains: `plugin.json`, `package.json`, `package-lock.json`, `CODEOWNERS`, `pieces/`, `renderers/`

---

## Task 2: Types (`pieces/types.ts`)

**Files:**
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/types.ts`

- [ ] **Step 1: Write types.ts**

```typescript
// pieces/types.ts
// All domain types for the reminder plugin.

// ─── Trigger (Dimension A — when) ────────────────────────────────
export type Trigger =
  | { type: "always" }
  | { type: "until_dismissed" }
  | { type: "once" }                               // inject once, then auto-dismiss
  | { type: "n_turns"; remaining: number }         // decrements each injection
  | { type: "until_date"; date: string }           // ISO 8601 — active until date
  | { type: "after_date"; date: string };          // ISO 8601 — active after date

// ─── Scope (Dimension B — where) ─────────────────────────────────
export type ScopeEntry =
  | "main"                                         // main session only
  | "all"                                          // any session
  | string                                         // literal ID: "actor-alice"
  | { match: string }                              // glob: "actor-*"
  | { regex: string };                             // regex: "^grpc-"

export type Scope = ScopeEntry | ScopeEntry[];     // single or union

// ─── Format (Dimension C — how) ───────────────────────────────────
export interface Format {
  style: "plain" | "system-reminder";
  severity?: "info" | "warning" | "important";
  title?: string;
}

// ─── Gating (Dimension D — extra condition) ───────────────────────
export type Gating = {
  type: "keyword";
  any: string[];
  caseSensitive?: boolean;
};

// ─── Reminder ─────────────────────────────────────────────────────
export interface Reminder {
  id: string;
  sessionIdOwner: string;
  text: string;

  createdAt: string;
  updatedAt: string;

  trigger: Trigger;
  scope: Scope;
  format: Format;
  gating?: Gating;

  active: boolean;       // false = dismissed
  paused: boolean;       // true = temporarily suspended
  triggeredCount: number;
  lastTriggeredAt?: string;
}

export interface ReminderSummary {
  total: number;
  active: number;
  paused: number;
  dismissed: number;
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/types.ts`

- [ ] **Step 2: Verify no syntax errors**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-reminders && node --input-type=module --eval "
import('./pieces/types.js').catch(e => { console.error(e.message); process.exit(1); });
" 2>&1 || echo "types.ts is .ts not .js — syntax check via tsc if available"
```

Types are TypeScript only so they won't run as JS — just verify the file exists and is non-empty:

```bash
wc -l ~/.jarvis/plugins/jarvis-plugin-reminders/pieces/types.ts
```

Expected: 50+ lines.

---

## Task 3: Store (`pieces/reminder-store.ts`)

**Files:**
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-store.ts`

The store only touches disk. No bus, no HUD, no business logic.

- [ ] **Step 1: Write reminder-store.ts**

```typescript
// pieces/reminder-store.ts
// Disk I/O for reminders. Reads/writes ~/.jarvis/reminders/<id>.md using gray-matter.
// No business logic here — just load/save/delete.

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import type { Reminder } from "./types.js";

const REMINDERS_DIR = join(process.env.HOME ?? "~", ".jarvis", "reminders");

export function ensureDir(): void {
  if (!existsSync(REMINDERS_DIR)) {
    mkdirSync(REMINDERS_DIR, { recursive: true });
  }
}

/** Load all reminders from disk. Skips and renames broken files. */
export function loadAll(): Reminder[] {
  ensureDir();
  const results: Reminder[] = [];

  const files = readdirSync(REMINDERS_DIR).filter(
    f => f.match(/^r-\d+\.md$/)
  );

  for (const file of files) {
    const filePath = join(REMINDERS_DIR, file);
    try {
      const parsed = matter.read(filePath);
      const data = parsed.data as Record<string, unknown>;
      const text = parsed.content.trim();

      const reminder: Reminder = {
        id: String(data.id),
        sessionIdOwner: String(data.sessionIdOwner ?? "main"),
        text,
        createdAt: String(data.createdAt ?? new Date().toISOString()),
        updatedAt: String(data.updatedAt ?? new Date().toISOString()),
        trigger: data.trigger as Reminder["trigger"],
        scope: data.scope as Reminder["scope"],
        format: (data.format ?? { style: "plain" }) as Reminder["format"],
        gating: data.gating as Reminder["gating"] | undefined,
        active: data.active !== false,
        paused: data.paused === true,
        triggeredCount: Number(data.triggeredCount ?? 0),
        lastTriggeredAt: data.lastTriggeredAt ? String(data.lastTriggeredAt) : undefined,
      };

      results.push(reminder);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[reminders] failed to parse ${file}: ${msg} — renamed to .broken`);
      try {
        renameSync(filePath, filePath + ".broken");
      } catch {}
    }
  }

  return results;
}

/** Serialize a Reminder to its .md file. */
export function save(reminder: Reminder): void {
  ensureDir();
  const { text, ...frontmatterData } = reminder;
  const fileContent = matter.stringify(text, frontmatterData);
  writeFileSync(join(REMINDERS_DIR, `${reminder.id}.md`), fileContent, "utf-8");
}

/** Delete a reminder's .md file. Silently ignores if not found. */
export function remove(id: string): void {
  const filePath = join(REMINDERS_DIR, `${id}.md`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

/** Extract the numeric part of "r-N" for ID counter bootstrapping. */
export function maxId(reminders: Reminder[]): number {
  let max = 0;
  for (const r of reminders) {
    const match = r.id.match(/^r-(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-store.ts`

- [ ] **Step 2: Verify file written**

```bash
wc -l ~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-store.ts
```

Expected: 70+ lines.

---

## Task 4: Engine (`pieces/reminder-engine.ts`)

**Files:**
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-engine.ts`

Pure functions only — no I/O, no side effects. Every function is independently testable.

- [ ] **Step 1: Write reminder-engine.ts**

```typescript
// pieces/reminder-engine.ts
// Pure functions: matching (trigger/scope/gating) and rendering.
// No I/O, no side effects, no bus access.

import type { Reminder, Trigger, Scope, ScopeEntry, Gating, Format } from "./types.js";

// ─── Trigger matching ─────────────────────────────────────────────

export function matchTrigger(trigger: Trigger, triggeredCount: number, now: Date): boolean {
  switch (trigger.type) {
    case "always":
      return true;
    case "until_dismissed":
      return true;
    case "once":
      return triggeredCount === 0;
    case "n_turns":
      return trigger.remaining > 0;
    case "until_date":
      return now < new Date(trigger.date);
    case "after_date":
      return now >= new Date(trigger.date);
  }
}

// ─── Side effects after injection ────────────────────────────────
// Returns a partial Reminder with the fields that changed.
// Caller is responsible for merging + persisting.

export function applyTriggerSideEffects(
  reminder: Reminder,
  now: Date
): Partial<Reminder> {
  const patch: Partial<Reminder> = {
    triggeredCount: reminder.triggeredCount + 1,
    lastTriggeredAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const trigger = reminder.trigger;

  if (trigger.type === "once") {
    patch.active = false;
  } else if (trigger.type === "n_turns") {
    const newRemaining = trigger.remaining - 1;
    patch.trigger = { type: "n_turns", remaining: newRemaining };
    if (newRemaining <= 0) patch.active = false;
  } else if (trigger.type === "until_date") {
    if (now >= new Date(trigger.date)) patch.active = false;
  }

  return patch;
}

// ─── Scope matching ───────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchScopeEntry(entry: ScopeEntry, sessionId: string): boolean {
  if (entry === "all") return true;
  if (entry === "main") return sessionId === "main";
  if (typeof entry === "string") return sessionId === entry;
  if ("match" in entry) {
    try { return globToRegex(entry.match).test(sessionId); } catch { return false; }
  }
  if ("regex" in entry) {
    try { return new RegExp(entry.regex).test(sessionId); } catch { return false; }
  }
  return false;
}

export function matchScope(scope: Scope, sessionId: string): boolean {
  const entries = Array.isArray(scope) ? scope : [scope];
  return entries.some(e => matchScopeEntry(e, sessionId));
}

// ─── Gating matching ─────────────────────────────────────────────

export function matchGating(
  gating: Gating | undefined,
  lastPrompt: string | undefined
): boolean {
  if (!gating) return true;
  if (!lastPrompt) return false;
  const haystack = gating.caseSensitive ? lastPrompt : lastPrompt.toLowerCase();
  return gating.any.some(kw => {
    const needle = gating.caseSensitive ? kw : kw.toLowerCase();
    return haystack.includes(needle);
  });
}

// ─── Render ───────────────────────────────────────────────────────

function renderSeverityPrefix(format: Format): string {
  if (!format.severity) return "";
  return `[${format.severity}] `;
}

function renderReminder(reminder: Reminder): string {
  const { format, text } = reminder;
  const titleLine = format.title ? `**${format.title}**\n\n` : "";
  const body = `${titleLine}${text}`;

  if (format.style === "system-reminder") {
    const severityAttr = format.severity ? ` severity="${format.severity}"` : "";
    return `<system-reminder${severityAttr}>\n${body}\n</system-reminder>`;
  }

  // plain — blockquote
  const prefix = format.severity ? `[${format.severity}] ` : "";
  const lines = body.split("\n").map(l => `> ${prefix}${l}`);
  return lines.join("\n");
}

/** Build the full systemContext string for a set of matching reminders. */
export function renderAll(reminders: Reminder[]): string {
  if (reminders.length === 0) return "";
  const blocks = reminders.map(renderReminder);
  return `## Active Reminders\n\n${blocks.join("\n\n")}`;
}

// ─── Filter: which reminders inject for a given session/prompt ───

export function filterInjectable(
  reminders: Reminder[],
  sessionId: string,
  lastPrompt: string | undefined,
  now: Date
): Reminder[] {
  return reminders.filter(r => {
    if (!r.active || r.paused) return false;
    if (!matchTrigger(r.trigger, r.triggeredCount, now)) return false;
    if (!matchScope(r.scope, sessionId)) return false;
    if (!matchGating(r.gating, lastPrompt)) return false;
    return true;
  });
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-engine.ts`

- [ ] **Step 2: Verify file written**

```bash
wc -l ~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-engine.ts
```

Expected: 100+ lines.

- [ ] **Step 3: Commit Task 2+3+4**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-reminders && git init && git add -A && git commit -m "feat: scaffold + types + store + engine"
```

Expected: initial commit created.

---

## Task 5: Piece skeleton + bus subscribe (`pieces/reminder-piece.ts` — part 1)

**Files:**
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-piece.ts`
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/index.ts`

- [ ] **Step 1: Write pieces/index.ts**

```typescript
// pieces/index.ts
import type { PluginContext } from "@jarvis/core";
import { ReminderPiece } from "./reminder-piece.js";

export function createPieces(ctx: PluginContext) {
  return [new ReminderPiece(ctx)];
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/index.ts`

- [ ] **Step 2: Write reminder-piece.ts skeleton**

```typescript
// pieces/reminder-piece.ts
// ReminderPiece — orchestrates reminder lifecycle, capabilities, HTTP routes, HUD.

import type { Piece, PluginContext, EventBus, CapabilityHandler } from "@jarvis/core";
import type { Reminder, ReminderSummary, Trigger, Scope, Format, Gating } from "./types.js";
import * as store from "./reminder-store.js";
import {
  filterInjectable,
  applyTriggerSideEffects,
  renderAll,
  matchScope,
} from "./reminder-engine.js";

export class ReminderPiece implements Piece {
  readonly id = "reminder-manager";
  readonly name = "Reminders";

  private bus!: EventBus;
  private ctx: PluginContext;

  private reminders = new Map<string, Reminder>();
  private idCounter = 0;
  private lastPrompts = new Map<string, string>();   // sessionId → last user prompt
  private dirty = new Set<string>();                  // reminder IDs needing flush
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private addedToHud = false;
  private unsubPrompt?: () => void;
  private unsubHudRemove?: () => void;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Load from disk
    const loaded = store.loadAll();
    for (const r of loaded) {
      this.reminders.set(r.id, r);
    }
    this.idCounter = store.maxId(loaded) + 1;
    console.log(
      `[reminders] loaded ${loaded.length} reminders (` +
      `${loaded.filter(r => r.active && !r.paused).length} active, ` +
      `${loaded.filter(r => r.paused).length} paused, ` +
      `${loaded.filter(r => !r.active).length} dismissed)`
    );

    // Subscribe to user prompts for keyword gating
    this.unsubPrompt = this.bus.subscribe("ai.request", (msg: any) => {
      if (msg.target && typeof msg.text === "string") {
        this.lastPrompts.set(msg.target, msg.text);
        // Prune map if it grows too large
        if (this.lastPrompts.size > 100) {
          const oldest = this.lastPrompts.keys().next().value;
          if (oldest) this.lastPrompts.delete(oldest);
        }
      }
    });

    // Track when user closes the HUD panel
    this.unsubHudRemove = this.bus.subscribe("hud.update", (msg: any) => {
      if (msg.action === "remove" && msg.pieceId === this.id && msg.source !== this.id) {
        this.addedToHud = false;
      }
    });

    this.registerCapabilities();
    this.registerRoutes();
    this.publishToHud();
  }

  async stop(): Promise<void> {
    this.unsubPrompt?.();
    this.unsubHudRemove?.();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // Synchronous flush on shutdown
    this.flushNow();
    if (this.addedToHud) {
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "remove",
        pieceId: this.id,
      });
      this.addedToHud = false;
    }
  }

  // ─── systemContext — injected each turn ───────────────────────

  systemContext(sessionId?: string): string {
    const sid = sessionId ?? "main";
    const now = new Date();
    const lastPrompt = this.lastPrompts.get(sid);

    const all = [...this.reminders.values()];
    const injectable = filterInjectable(all, sid, lastPrompt, now);

    if (injectable.length === 0) return "";

    // Apply side effects (count++, auto-dismiss, n_turns decrement)
    let hudNeedsUpdate = false;
    for (const r of injectable) {
      const patch = applyTriggerSideEffects(r, now);
      Object.assign(r, patch);
      this.markDirty(r.id);
      if (patch.active === false) {
        console.log(`[reminders] ${r.id} auto-dismissed (${r.trigger.type} trigger fired)`);
      }
      hudNeedsUpdate = true;
    }

    if (hudNeedsUpdate) this.publishToHud();

    return renderAll(injectable);
  }

  // ─── State helpers ────────────────────────────────────────────

  private nextId(): string {
    return `r-${this.idCounter++}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushNow(), 300);
  }

  private markDeleted(id: string): void {
    this.dirty.delete(id);
    store.remove(id);
  }

  private flushNow(): void {
    for (const id of this.dirty) {
      const r = this.reminders.get(id);
      if (r) store.save(r);
    }
    this.dirty.clear();
    this.flushTimer = null;
  }

  private summarize(): ReminderSummary {
    const all = [...this.reminders.values()];
    return {
      total: all.length,
      active: all.filter(r => r.active && !r.paused).length,
      paused: all.filter(r => r.paused).length,
      dismissed: all.filter(r => !r.active).length,
    };
  }

  private publishToHud(): void {
    const data = {
      reminders: [...this.reminders.values()].map(r => ({ ...r })),
      summary: this.summarize(),
    };

    this.addedToHud = true;
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: "running",
        data: data as unknown as Record<string, unknown>,
        position: { x: 1240, y: 850 },
        size: { width: 540, height: 420 },
        renderer: { plugin: "jarvis-plugin-reminders", file: "ReminderRenderer" },
      },
      data: data as unknown as Record<string, unknown>,
      status: "running",
      visible: true,
    });
  }

  // ─── Capabilities ─────────────────────────────────────────────

  private registerCapabilities(): void {
    const reg = this.ctx.capabilityRegistry;

    // ── reminder_create ──────────────────────────────────────────
    reg.register({
      name: "reminder_create",
      description:
        "Create a reminder injected into the system prompt of future turns. " +
        "Configure WHEN (trigger), WHERE (scope), HOW (format), and OPTIONAL CONDITION (gating). " +
        "Use for behavioral rules ('always lint before commit'), context anchors ('debugging bug X'), " +
        "or scheduled nudges. Owned by the calling session.",
      input_schema: {
        type: "object",
        required: ["text", "trigger", "scope"],
        properties: {
          text: {
            type: "string",
            description: "Reminder body (markdown). Keep concise — injected on every matching turn.",
          },
          trigger: {
            type: "object",
            description:
              "When the reminder injects. type: 'always' | 'until_dismissed' | 'once' | 'n_turns' | 'until_date' | 'after_date'. " +
              "n_turns requires remaining:number. until_date/after_date require date:ISO8601.",
          },
          scope: {
            description:
              "Which sessions see this. 'main' | 'all' | session-id-string | {match:'glob*'} | {regex:'^pattern'} | array of any.",
          },
          format: {
            type: "object",
            description:
              "How to render. style: 'plain' (blockquote) | 'system-reminder' (wrapped tag). " +
              "Optional severity: 'info' | 'warning' | 'important'. Optional title string.",
          },
          gating: {
            type: "object",
            description:
              "Only inject when the last user prompt contains a keyword. " +
              "{ type: 'keyword', any: ['word1','word2'], caseSensitive?: false }",
          },
        },
      },
      handler: (async (input: Record<string, unknown>) => {
        const sessionId = String(input.__sessionId ?? "main");
        const text = String(input.text ?? "").trim();
        if (!text) return { success: false, error: "text is required" };

        const trigger = input.trigger as Trigger | undefined;
        if (!trigger?.type) return { success: false, error: "trigger is required (must have .type)" };

        const scope = input.scope as Scope | undefined;
        if (!scope) return { success: false, error: "scope is required" };

        const format = (input.format as Format | undefined) ?? { style: "plain" as const };
        const gating = input.gating as Gating | undefined;

        const id = this.nextId();
        const reminder: Reminder = {
          id,
          sessionIdOwner: sessionId,
          text,
          createdAt: this.now(),
          updatedAt: this.now(),
          trigger,
          scope,
          format,
          gating,
          active: true,
          paused: false,
          triggeredCount: 0,
        };

        this.reminders.set(id, reminder);
        this.markDirty(id);
        this.publishToHud();

        return { success: true, reminder: { ...reminder } };
      }) as CapabilityHandler,
    });

    // ── reminder_list ────────────────────────────────────────────
    reg.register({
      name: "reminder_list",
      description:
        "List ALL reminders. Filter by status (active/paused/dismissed), owner, or preview which reminders would inject in a given session.",
      input_schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["active", "paused", "dismissed"],
            description: "Filter by status.",
          },
          sessionIdOwner: {
            type: "string",
            description: "Filter by owner session ID.",
          },
          matchesSession: {
            type: "string",
            description: "Preview: return only reminders whose scope would match this sessionId.",
          },
        },
      },
      handler: (async (input: Record<string, unknown>) => {
        let reminders = [...this.reminders.values()];

        if (input.status === "active") reminders = reminders.filter(r => r.active && !r.paused);
        else if (input.status === "paused") reminders = reminders.filter(r => r.paused);
        else if (input.status === "dismissed") reminders = reminders.filter(r => !r.active);

        if (input.sessionIdOwner) {
          reminders = reminders.filter(r => r.sessionIdOwner === String(input.sessionIdOwner));
        }

        if (input.matchesSession) {
          const sid = String(input.matchesSession);
          reminders = reminders.filter(r => matchScope(r.scope, sid));
        }

        return {
          success: true,
          reminders: reminders.map(r => ({ ...r })),
          summary: this.summarize(),
        };
      }) as CapabilityHandler,
    });

    // ── reminder_get ─────────────────────────────────────────────
    reg.register({
      name: "reminder_get",
      description: "Get full details of a reminder by ID.",
      input_schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      handler: (async (input: Record<string, unknown>) => {
        const r = this.reminders.get(String(input.id));
        if (!r) return { success: false, error: `Reminder ${input.id} not found` };
        return { success: true, reminder: { ...r } };
      }) as CapabilityHandler,
    });

    // ── reminder_update ──────────────────────────────────────────
    reg.register({
      name: "reminder_update",
      description:
        "Update reminder fields. Owner-only. Nested objects (trigger/scope/format/gating) are fully replaced — not merged.",
      input_schema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          trigger: { type: "object" },
          scope: {},
          format: { type: "object" },
          gating: { description: "Pass null to remove gating." },
        },
      },
      handler: (async (input: Record<string, unknown>) => {
        const id = String(input.id);
        const r = this.reminders.get(id);
        if (!r) return { success: false, error: `Reminder ${id} not found` };

        const caller = String(input.__sessionId ?? "main");
        if (r.sessionIdOwner !== caller) {
          return { success: false, error: `Reminder ${id} belongs to session "${r.sessionIdOwner}" — only its owner can update it.` };
        }

        if (input.text !== undefined) r.text = String(input.text).trim();
        if (input.trigger !== undefined) r.trigger = input.trigger as Trigger;
        if (input.scope !== undefined) r.scope = input.scope as Scope;
        if (input.format !== undefined) r.format = input.format as Format;
        if ("gating" in input) r.gating = input.gating == null ? undefined : input.gating as Gating;
        r.updatedAt = this.now();

        this.markDirty(id);
        this.publishToHud();

        return { success: true, reminder: { ...r } };
      }) as CapabilityHandler,
    });

    // ── reminder_delete ──────────────────────────────────────────
    reg.register({
      name: "reminder_delete",
      description: "Delete a reminder permanently. Owner-only.",
      input_schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      handler: (async (input: Record<string, unknown>) => {
        const id = String(input.id);
        const r = this.reminders.get(id);
        if (!r) return { success: false, error: `Reminder ${id} not found` };

        const caller = String(input.__sessionId ?? "main");
        if (r.sessionIdOwner !== caller) {
          return { success: false, error: `Reminder ${id} belongs to session "${r.sessionIdOwner}" — only its owner can delete it.` };
        }

        this.reminders.delete(id);
        this.markDeleted(id);
        this.publishToHud();

        return { success: true, deleted: id };
      }) as CapabilityHandler,
    });

    // ── reminder_dismiss ─────────────────────────────────────────
    reg.register({
      name: "reminder_dismiss",
      description:
        "Mark reminder as dismissed (active=false). Use when the concern is resolved. " +
        "Reminder is preserved (not deleted) for history. Owner-only.",
      input_schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      handler: (async (input: Record<string, unknown>) => {
        const id = String(input.id);
        const r = this.reminders.get(id);
        if (!r) return { success: false, error: `Reminder ${id} not found` };

        const caller = String(input.__sessionId ?? "main");
        if (r.sessionIdOwner !== caller) {
          return { success: false, error: `Reminder ${id} belongs to session "${r.sessionIdOwner}" — only its owner can dismiss it.` };
        }

        r.active = false;
        r.updatedAt = this.now();
        this.markDirty(id);
        this.publishToHud();

        return { success: true, reminder: { ...r } };
      }) as CapabilityHandler,
    });

    // ── reminder_pause ───────────────────────────────────────────
    reg.register({
      name: "reminder_pause",
      description: "Suspend reminder injection without dismissing. Owner-only.",
      input_schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      handler: (async (input: Record<string, unknown>) => {
        const id = String(input.id);
        const r = this.reminders.get(id);
        if (!r) return { success: false, error: `Reminder ${id} not found` };

        const caller = String(input.__sessionId ?? "main");
        if (r.sessionIdOwner !== caller) {
          return { success: false, error: `Reminder ${id} belongs to session "${r.sessionIdOwner}" — only its owner can pause it.` };
        }

        r.paused = true;
        r.updatedAt = this.now();
        this.markDirty(id);
        this.publishToHud();

        return { success: true, reminder: { ...r } };
      }) as CapabilityHandler,
    });

    // ── reminder_resume ──────────────────────────────────────────
    reg.register({
      name: "reminder_resume",
      description: "Resume a paused reminder. Resets paused=false and reactivates if dismissed. Owner-only.",
      input_schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      handler: (async (input: Record<string, unknown>) => {
        const id = String(input.id);
        const r = this.reminders.get(id);
        if (!r) return { success: false, error: `Reminder ${id} not found` };

        const caller = String(input.__sessionId ?? "main");
        if (r.sessionIdOwner !== caller) {
          return { success: false, error: `Reminder ${id} belongs to session "${r.sessionIdOwner}" — only its owner can resume it.` };
        }

        r.paused = false;
        r.active = true;   // reactivate even if dismissed
        r.updatedAt = this.now();
        this.markDirty(id);
        this.publishToHud();

        return { success: true, reminder: { ...r } };
      }) as CapabilityHandler,
    });
  }

  // ─── HTTP Routes (HUD bypass — no owner-only check) ──────────

  private registerRoutes(): void {
    const base = "/plugins/reminders";

    // GET /plugins/reminders/list?status=&owner=
    this.ctx.registerRoute("GET", `${base}/list`, async (req: any, res: any) => {
      const url = new URL(req.url, "http://localhost");
      const status = url.searchParams.get("status") ?? undefined;
      const owner = url.searchParams.get("owner") ?? undefined;

      let reminders = [...this.reminders.values()];
      if (status === "active") reminders = reminders.filter(r => r.active && !r.paused);
      else if (status === "paused") reminders = reminders.filter(r => r.paused);
      else if (status === "dismissed") reminders = reminders.filter(r => !r.active);
      if (owner) reminders = reminders.filter(r => r.sessionIdOwner === owner);

      sendJson(res, 200, { ok: true, reminders: reminders.map(r => ({ ...r })), summary: this.summarize() });
    });

    // POST /plugins/reminders/create
    this.ctx.registerRoute("POST", `${base}/create`, async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req);
        const text = String(body.text ?? "").trim();
        if (!text) return sendJson(res, 400, { ok: false, error: "text is required" });
        if (!body.trigger?.type) return sendJson(res, 400, { ok: false, error: "trigger is required" });
        if (!body.scope) return sendJson(res, 400, { ok: false, error: "scope is required" });

        const id = this.nextId();
        const reminder: Reminder = {
          id,
          sessionIdOwner: String(body.sessionIdOwner ?? "main"),
          text,
          createdAt: this.now(),
          updatedAt: this.now(),
          trigger: body.trigger as Trigger,
          scope: body.scope as Scope,
          format: (body.format ?? { style: "plain" }) as Format,
          gating: body.gating as Gating | undefined,
          active: true,
          paused: false,
          triggeredCount: 0,
        };

        this.reminders.set(id, reminder);
        this.markDirty(id);
        this.publishToHud();
        sendJson(res, 200, { ok: true, reminder: { ...reminder } });
      } catch (e: any) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      }
    });

    // POST /plugins/reminders/update/<id>
    this.ctx.registerRoute("POST", `${base}/update/`, async (req: any, res: any) => {
      const id = req.url?.split(`${base}/update/`)[1]?.split("?")[0];
      if (!id) return sendJson(res, 400, { ok: false, error: "Missing id" });
      const r = this.reminders.get(id);
      if (!r) return sendJson(res, 404, { ok: false, error: `Reminder ${id} not found` });
      try {
        const body = await readJsonBody(req);
        if (body.text !== undefined) r.text = String(body.text).trim();
        if (body.trigger !== undefined) r.trigger = body.trigger as Trigger;
        if (body.scope !== undefined) r.scope = body.scope as Scope;
        if (body.format !== undefined) r.format = body.format as Format;
        if ("gating" in body) r.gating = body.gating == null ? undefined : body.gating as Gating;
        r.updatedAt = this.now();
        this.markDirty(id);
        this.publishToHud();
        sendJson(res, 200, { ok: true, reminder: { ...r } });
      } catch (e: any) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      }
    });

    // POST /plugins/reminders/delete/<id>
    this.ctx.registerRoute("POST", `${base}/delete/`, async (req: any, res: any) => {
      const id = req.url?.split(`${base}/delete/`)[1]?.split("?")[0];
      if (!id) return sendJson(res, 400, { ok: false, error: "Missing id" });
      if (!this.reminders.has(id)) return sendJson(res, 404, { ok: false, error: `Reminder ${id} not found` });
      this.reminders.delete(id);
      this.markDeleted(id);
      this.publishToHud();
      sendJson(res, 200, { ok: true, deleted: id });
    });

    // POST /plugins/reminders/dismiss/<id>
    this.ctx.registerRoute("POST", `${base}/dismiss/`, async (req: any, res: any) => {
      const id = req.url?.split(`${base}/dismiss/`)[1]?.split("?")[0];
      if (!id) return sendJson(res, 400, { ok: false, error: "Missing id" });
      const r = this.reminders.get(id);
      if (!r) return sendJson(res, 404, { ok: false, error: `Reminder ${id} not found` });
      r.active = false;
      r.updatedAt = this.now();
      this.markDirty(id);
      this.publishToHud();
      sendJson(res, 200, { ok: true, reminder: { ...r } });
    });

    // POST /plugins/reminders/pause/<id>
    this.ctx.registerRoute("POST", `${base}/pause/`, async (req: any, res: any) => {
      const id = req.url?.split(`${base}/pause/`)[1]?.split("?")[0];
      if (!id) return sendJson(res, 400, { ok: false, error: "Missing id" });
      const r = this.reminders.get(id);
      if (!r) return sendJson(res, 404, { ok: false, error: `Reminder ${id} not found` });
      r.paused = true;
      r.updatedAt = this.now();
      this.markDirty(id);
      this.publishToHud();
      sendJson(res, 200, { ok: true, reminder: { ...r } });
    });

    // POST /plugins/reminders/resume/<id>
    this.ctx.registerRoute("POST", `${base}/resume/`, async (req: any, res: any) => {
      const id = req.url?.split(`${base}/resume/`)[1]?.split("?")[0];
      if (!id) return sendJson(res, 400, { ok: false, error: "Missing id" });
      const r = this.reminders.get(id);
      if (!r) return sendJson(res, 404, { ok: false, error: `Reminder ${id} not found` });
      r.paused = false;
      r.active = true;
      r.updatedAt = this.now();
      this.markDirty(id);
      this.publishToHud();
      sendJson(res, 200, { ok: true, reminder: { ...r } });
    });

    // POST /plugins/reminders/clear  — BULK DELETE, HUD only
    this.ctx.registerRoute("POST", `${base}/clear`, async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req);
        const owner = body.sessionIdOwner ? String(body.sessionIdOwner) : undefined;
        const clearAll = body.all === true;

        let removed = 0;
        for (const [id, r] of this.reminders) {
          if (owner && r.sessionIdOwner !== owner) continue;
          if (!clearAll && r.active) continue;  // default: only dismissed
          this.reminders.delete(id);
          this.markDeleted(id);
          removed++;
        }
        this.publishToHud();
        sendJson(res, 200, { ok: true, removed });
      } catch (e: any) {
        sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      }
    });
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: any, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/pieces/reminder-piece.ts`

- [ ] **Step 3: Commit**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-reminders && git add -A && git commit -m "feat: piece skeleton, capabilities, HTTP routes"
```

Expected: commit created.

---

## Task 6: Static docs (`context.md`, `README.md`, `functional-test.md`)

**Files:**
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/context.md`
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/README.md`
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/functional-test.md`

- [ ] **Step 1: Write context.md**

```markdown
# Reminders Plugin

You have reminder tools to inject configurable text blocks into the system prompt on future turns.

## Tools

- `reminder_create(text, trigger, scope, format?, gating?)` — Create a reminder. Owned by your session.
- `reminder_list(status?, sessionIdOwner?, matchesSession?)` — List reminders with optional filters.
- `reminder_get(id)` — Full details of a reminder.
- `reminder_update(id, text?, trigger?, scope?, format?, gating?)` — Update fields. Owner-only. Nested objects fully replaced.
- `reminder_delete(id)` — Delete permanently. Owner-only.
- `reminder_dismiss(id)` — Mark resolved (active=false). Preserved for history. Owner-only.
- `reminder_pause(id)` — Suspend without dismissing. Owner-only.
- `reminder_resume(id)` — Reactivate a paused or dismissed reminder. Owner-only.

## Trigger types (when)

- `{ type: "always" }` — every turn
- `{ type: "until_dismissed" }` — every turn until dismissed
- `{ type: "once" }` — next turn only, then auto-dismissed
- `{ type: "n_turns", remaining: N }` — next N turns
- `{ type: "until_date", date: "ISO8601" }` — until a date/time
- `{ type: "after_date", date: "ISO8601" }` — starting from a date/time

## Scope (where — which sessions see it)

- `"main"` — main session only
- `"all"` — every session
- `"actor-alice"` — literal session ID
- `{ match: "actor-coder-*" }` — glob pattern
- `{ regex: "^actor-" }` — regex pattern
- `["main", { match: "actor-*" }]` — array = union (any match)

## Format (how)

- `{ style: "plain" }` — blockquote (default)
- `{ style: "system-reminder" }` — wrapped in `<system-reminder>` tag (stronger emphasis)
- Optional `severity: "info" | "warning" | "important"` — adds visual label
- Optional `title: "string"` — bold header on the reminder

## Gating (optional extra condition)

Only injects when the last user message contains a keyword:
`{ type: "keyword", any: ["commit", "PR", "deploy"], caseSensitive: false }`

## Best practices

- Prefer `until_dismissed` for open-ended behavioral rules ("always use TDD")
- Use `n_turns` for short-lived context anchors (next 3–5 turns)
- Use `gating: keyword` aggressively — a gated reminder costs zero tokens when the keyword is absent
- Use `style: "plain"` unless you genuinely need emphasis
- Keep `text` short — reminders are policies, not documentation
- Call `reminder_dismiss` immediately when the underlying concern is resolved
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/context.md`

- [ ] **Step 2: Write README.md**

```markdown
# jarvis-plugin-reminders

Configurable reminders injected into the JARVIS system prompt on each turn.

## Features

- **8 LLM tools** — create, list, get, update, delete, dismiss, pause, resume
- **4 injection dimensions** — trigger (when), scope (where), format (how), gating (condition)
- **HUD panel** — full CRUD, filter by status, inline create/edit form
- **Persistence** — one `.md` file per reminder in `~/.jarvis/reminders/`

## Trigger types

`always` · `until_dismissed` · `once` · `n_turns` · `until_date` · `after_date`

## Scope patterns

`"main"` · `"all"` · literal ID · `{match:"glob*"}` · `{regex:"^pattern"}` · array union

## Reminder files

Stored in `~/.jarvis/reminders/r-N.md` with YAML frontmatter. Safe to edit manually.

## Installation

```bash
plugin_install github.com/giovanibarili/jarvis-plugin-reminders
```
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/README.md`

- [ ] **Step 3: Write functional-test.md**

```markdown
# jarvis-plugin-reminders — Functional Tests

Run ALL scenarios after install/update. No skipping.

---

## Scenario 1: Create reminder with always trigger
GIVEN no reminders exist
WHEN I call `reminder_create` with text="Use Portuguese", trigger={type:"always"}, scope="main"
THEN result has success=true and reminder.id="r-1"
AND reminder has active=true, paused=false, triggeredCount=0
AND file `~/.jarvis/reminders/r-1.md` exists with valid YAML frontmatter
WHEN I call `session_get_system` and check for "Use Portuguese"
THEN "Use Portuguese" appears in the system context for session "main"
WHEN I call `reminder_get({id:"r-1"})`
THEN triggeredCount is 1

## Scenario 2: once trigger auto-dismisses after first injection
GIVEN reminder created with trigger={type:"once"}, scope="main"
LET id = the created reminder's id
WHEN systemContext("main") is called (first time)
THEN the reminder text appears in the output
AND reminder.active becomes false
WHEN systemContext("main") is called again
THEN the reminder text does NOT appear

## Scenario 3: n_turns decrements and auto-dismisses
GIVEN reminder with trigger={type:"n_turns", remaining:2}, scope="main"
LET id = created id
WHEN systemContext("main") called → remaining becomes 1, active=true
WHEN systemContext("main") called again → remaining becomes 0, active=false
WHEN systemContext("main") called third time → reminder NOT rendered

## Scenario 4: Scope "main" filters correctly
GIVEN reminder with scope="main"
WHEN systemContext("actor-alice") is called
THEN reminder NOT rendered
WHEN systemContext("main") is called
THEN reminder IS rendered

## Scenario 5: Scope glob match
GIVEN reminder with scope={match:"actor-coder-*"}
WHEN systemContext("actor-coder-alice") is called → rendered
WHEN systemContext("actor-researcher-bob") is called → NOT rendered
WHEN systemContext("main") is called → NOT rendered

## Scenario 6: Scope array union
GIVEN reminder with scope=["main", {match:"actor-*"}]
WHEN systemContext("main") → rendered
WHEN systemContext("actor-alice") → rendered
WHEN systemContext("grpc-x") → NOT rendered

## Scenario 7: Keyword gating — blocks when keyword absent
GIVEN reminder with gating={type:"keyword", any:["commit","PR"]}, scope="main"
AND last user prompt for "main" was "let me write tests"
WHEN systemContext("main") is called
THEN reminder NOT rendered
GIVEN last user prompt becomes "ready to commit this"
WHEN systemContext("main") is called
THEN reminder IS rendered

## Scenario 8: reminder_dismiss makes inactive
GIVEN active reminder r-X owned by "main"
WHEN `reminder_dismiss({id:"r-X"})` called from session "main"
THEN result.reminder.active=false
AND systemContext("main") no longer renders the reminder

## Scenario 9: Owner-only on dismiss
GIVEN reminder r-X owned by "main"
WHEN `reminder_dismiss({id:"r-X"})` called from session "actor-alice"
THEN result.success=false AND error contains "belongs to session"

## Scenario 10: reminder_pause suspends without dismissing
GIVEN active reminder r-X
WHEN `reminder_pause({id:"r-X"})`
THEN r-X.paused=true, r-X.active=true
AND systemContext does NOT render it
WHEN `reminder_resume({id:"r-X"})`
THEN r-X.paused=false
AND systemContext renders it again

## Scenario 11: until_date in past — never renders
GIVEN reminder with trigger={type:"until_date", date:"2020-01-01T00:00:00Z"}
WHEN systemContext is called
THEN reminder NOT rendered

## Scenario 12: after_date in far future — not yet
GIVEN reminder with trigger={type:"after_date", date:"2099-01-01T00:00:00Z"}
WHEN systemContext is called
THEN reminder NOT rendered

## Scenario 13: Persistence across restart
GIVEN 2 reminders exist (r-1 active, r-2 dismissed)
WHEN `plugin_update jarvis-plugin-reminders` (forces reload)
THEN both reminders still present with same IDs, same active/paused state

## Scenario 14: HUD panel renders reminder cards
WHEN `reminder_create` is called successfully
THEN HUD shows a panel with id="reminder-manager"
AND panel data.reminders contains the created reminder

## Scenario 15: HTTP create bypasses owner-only
WHEN POST /plugins/reminders/create with body {sessionIdOwner:"actor-alice", text:"test", trigger:{type:"always"}, scope:"main"}
THEN response ok=true
AND reminder.sessionIdOwner="actor-alice"

## Scenario 16: HTTP /clear removes only dismissed by default
GIVEN 3 reminders: r-1 active, r-2 paused, r-3 dismissed (all owned by "main")
WHEN POST /plugins/reminders/clear with body {}
THEN response ok=true, removed=1
AND r-1 and r-2 still exist
AND r-3 is deleted

## Scenario 17: Corrupted .md does not block boot
GIVEN ~/.jarvis/reminders/r-99.md contains invalid YAML (e.g. "{{ broken")
WHEN plugin reloads
THEN other reminders load correctly
AND r-99.md renamed to r-99.md.broken
AND warning logged containing "failed to parse"

## Scenario 18: No matching reminders returns empty string
GIVEN no reminder matches scope="main" (all scoped to "actor-only")
WHEN systemContext("main") is called
THEN returns "" (empty string, no "## Active Reminders" header)

## Scenario 19: format system-reminder wraps output
GIVEN reminder with format={style:"system-reminder", severity:"warning", title:"Lint"}, text="Run lint"
WHEN systemContext renders it
THEN output contains `<system-reminder severity="warning">`
AND output contains `**Lint**`
AND output contains `Run lint`
AND output contains `</system-reminder>`

## Scenario 20: reminder_update nested object is full replace (not merge)
GIVEN reminder r-X with gating={type:"keyword", any:["a","b"]}
WHEN `reminder_update({id:"r-X", gating:{type:"keyword", any:["c"]}})`
THEN r-X.gating.any = ["c"]  (NOT ["a","b","c"])
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/functional-test.md`

- [ ] **Step 4: Commit**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-reminders && git add -A && git commit -m "docs: context.md, README.md, functional-test.md (20 scenarios)"
```

---

## Task 7: HUD Renderer (`renderers/ReminderRenderer.tsx`)

**Files:**
- Create: `~/.jarvis/plugins/jarvis-plugin-reminders/renderers/ReminderRenderer.tsx`

React component following the TaskRenderer pattern. React is injected via `window.__JARVIS_REACT` — no import statement. All types declared inline (no imports from pieces/).

- [ ] **Step 1: Write ReminderRenderer.tsx**

```tsx
// renderers/ReminderRenderer.tsx
// HUD panel for reminder management.
// React hooks injected via window.__JARVIS_REACT (no import).

// ─── Types (inline — no cross-boundary imports) ────────────────

interface Trigger {
  type: "always" | "until_dismissed" | "once" | "n_turns" | "until_date" | "after_date";
  remaining?: number;
  date?: string;
}

interface Format {
  style: "plain" | "system-reminder";
  severity?: "info" | "warning" | "important";
  title?: string;
}

interface Gating {
  type: "keyword";
  any: string[];
  caseSensitive?: boolean;
}

type ScopeEntry = "main" | "all" | string | { match: string } | { regex: string };
type Scope = ScopeEntry | ScopeEntry[];

interface Reminder {
  id: string;
  sessionIdOwner: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  trigger: Trigger;
  scope: Scope;
  format: Format;
  gating?: Gating;
  active: boolean;
  paused: boolean;
  triggeredCount: number;
  lastTriggeredAt?: string;
}

interface ReminderSummary {
  total: number;
  active: number;
  paused: number;
  dismissed: number;
}

interface ReminderData {
  reminders: Reminder[];
  summary: ReminderSummary;
}

// ─── HTTP helpers ──────────────────────────────────────────────

const BASE = "/plugins/reminders";

async function post(path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function getList(status?: string, owner?: string): Promise<Reminder[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (owner) params.set("owner", owner);
  const res = await fetch(`${BASE}/list?${params}`);
  const data = await res.json();
  return data.reminders ?? [];
}

// ─── Helpers ──────────────────────────────────────────────────

function scopeSummary(scope: Scope): string {
  const entries = Array.isArray(scope) ? scope : [scope];
  const parts = entries.map(e => {
    if (typeof e === "string") return e;
    if ("match" in e) return `${e.match}`;
    if ("regex" in e) return `/${e.regex}/`;
    return "?";
  });
  if (parts.length <= 2) return parts.join(", ");
  return parts.slice(0, 2).join(", ") + ` +${parts.length - 2}`;
}

function triggerSummary(trigger: Trigger): string {
  switch (trigger.type) {
    case "always": return "always";
    case "until_dismissed": return "until dismissed";
    case "once": return "once";
    case "n_turns": return `${trigger.remaining ?? 0} turns left`;
    case "until_date": return `until ${trigger.date?.slice(0, 10)}`;
    case "after_date": return `after ${trigger.date?.slice(0, 10)}`;
  }
}

function gatingLabel(gating?: Gating): string | null {
  if (!gating) return null;
  return `keyword: ${gating.any.slice(0, 3).join(", ")}`;
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function severityIcon(r: Reminder): string {
  if (!r.active) return "✅";
  if (r.paused) return "⏸";
  switch (r.format.severity) {
    case "info": return "🟢";
    case "warning": return "🟡";
    case "important": return "🔴";
    default: return "⚪";
  }
}

const SEVERITY_COLOR: Record<string, string> = {
  info: "var(--ok, #22c55e)",
  warning: "var(--warn, #f59e0b)",
  important: "var(--err, #ef4444)",
};

// ─── Empty form state ─────────────────────────────────────────

interface FormState {
  title: string;
  text: string;
  triggerType: Trigger["type"];
  triggerRemaining: string;
  triggerDate: string;
  scopeMain: boolean;
  scopeAll: boolean;
  scopePattern: string;
  scopeRegex: string;
  scopeLiteral: string;
  formatStyle: "plain" | "system-reminder";
  formatSeverity: "" | "info" | "warning" | "important";
  gatingEnabled: boolean;
  gatingKeywords: string;
  gatingCaseSensitive: boolean;
}

function emptyForm(): FormState {
  return {
    title: "", text: "",
    triggerType: "until_dismissed",
    triggerRemaining: "3", triggerDate: "",
    scopeMain: true, scopeAll: false,
    scopePattern: "", scopeRegex: "", scopeLiteral: "",
    formatStyle: "plain", formatSeverity: "",
    gatingEnabled: false, gatingKeywords: "", gatingCaseSensitive: false,
  };
}

function formToPayload(f: FormState, owner: string) {
  // Build scope array
  const scopeEntries: ScopeEntry[] = [];
  if (f.scopeAll) { scopeEntries.push("all"); }
  else {
    if (f.scopeMain) scopeEntries.push("main");
    if (f.scopePattern.trim()) scopeEntries.push({ match: f.scopePattern.trim() });
    if (f.scopeRegex.trim()) scopeEntries.push({ regex: f.scopeRegex.trim() });
    if (f.scopeLiteral.trim()) f.scopeLiteral.split(",").forEach(s => {
      const t = s.trim(); if (t) scopeEntries.push(t);
    });
  }
  const scope: Scope = scopeEntries.length === 1 ? scopeEntries[0] : scopeEntries;

  // Build trigger
  let trigger: Trigger;
  if (f.triggerType === "n_turns") {
    trigger = { type: "n_turns", remaining: parseInt(f.triggerRemaining) || 3 };
  } else if (f.triggerType === "until_date" || f.triggerType === "after_date") {
    trigger = { type: f.triggerType, date: new Date(f.triggerDate).toISOString() };
  } else {
    trigger = { type: f.triggerType };
  }

  // Build format
  const format: Format = { style: f.formatStyle };
  if (f.formatSeverity) format.severity = f.formatSeverity as Format["severity"];
  if (f.title.trim()) format.title = f.title.trim();

  // Build text (use title if text empty guard is in form)
  const text = f.text.trim();

  // Build gating
  const gating: Gating | undefined = f.gatingEnabled && f.gatingKeywords.trim()
    ? { type: "keyword", any: f.gatingKeywords.split(",").map(s => s.trim()).filter(Boolean), caseSensitive: f.gatingCaseSensitive }
    : undefined;

  return { sessionIdOwner: owner, text, trigger, scope, format, ...(gating ? { gating } : {}) };
}

function reminderToForm(r: Reminder): FormState {
  const f = emptyForm();
  f.title = r.format.title ?? "";
  f.text = r.text;
  f.triggerType = r.trigger.type;
  if (r.trigger.type === "n_turns") f.triggerRemaining = String(r.trigger.remaining);
  if (r.trigger.type === "until_date" || r.trigger.type === "after_date") f.triggerDate = r.trigger.date ?? "";
  const entries = Array.isArray(r.scope) ? r.scope : [r.scope];
  f.scopeAll = entries.includes("all");
  f.scopeMain = entries.includes("main");
  const matchEntry = entries.find(e => typeof e === "object" && "match" in e) as { match: string } | undefined;
  if (matchEntry) f.scopePattern = matchEntry.match;
  const regexEntry = entries.find(e => typeof e === "object" && "regex" in e) as { regex: string } | undefined;
  if (regexEntry) f.scopeRegex = regexEntry.regex;
  f.formatStyle = r.format.style;
  f.formatSeverity = r.format.severity ?? "";
  if (r.gating) {
    f.gatingEnabled = true;
    f.gatingKeywords = r.gating.any.join(", ");
    f.gatingCaseSensitive = r.gating.caseSensitive ?? false;
  }
  return f;
}

// ─── Main Component ───────────────────────────────────────────

export default function ReminderRenderer({ data }: { data: ReminderData }) {
  const { useState, useCallback } = (window as any).__JARVIS_REACT;

  type FilterType = "active" | "paused" | "dismissed" | "all";
  const [filter, setFilter] = useState<FilterType>("active");
  const [reminders, setReminders] = useState<Reminder[]>(data?.reminders ?? []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync when HUD pushes new data
  if (data?.reminders && data.reminders !== reminders) {
    setReminders(data.reminders);
  }

  const refresh = useCallback(async () => {
    const all = await getList();
    setReminders(all);
  }, []);

  const filtered = reminders.filter(r => {
    if (filter === "active") return r.active && !r.paused;
    if (filter === "paused") return r.paused;
    if (filter === "dismissed") return !r.active;
    return true;
  });

  const activeCount = reminders.filter(r => r.active && !r.paused).length;

  // ── Actions ───────────────────────────────────────────────────

  async function handleAction(action: string, id: string) {
    await post(`${BASE}/${action}/${id}`);
    await refresh();
  }

  async function handleSubmit() {
    const owner = editingId ? (reminders.find(r => r.id === editingId)?.sessionIdOwner ?? "main") : "main";
    const payload = formToPayload(form, owner);
    if (!payload.text) { setError("Text is required"); return; }

    if (editingId) {
      await post(`${BASE}/update/${editingId}`, payload);
    } else {
      await post(`${BASE}/create`, payload);
    }

    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
    await refresh();
  }

  function handleEdit(r: Reminder) {
    setEditingId(r.id);
    setForm(reminderToForm(r));
    setShowForm(true);
  }

  function handleNew() {
    setEditingId(null);
    setForm(emptyForm());
    setShowForm(true);
    setError(null);
  }

  async function handleClearDismissed() {
    await post(`${BASE}/clear`, {});
    setShowClearConfirm(false);
    await refresh();
  }

  async function handleDelete(id: string) {
    await post(`${BASE}/delete/${id}`);
    setConfirmDeleteId(null);
    await refresh();
  }

  // ── Styles ────────────────────────────────────────────────────

  const panelStyle: any = {
    fontFamily: "monospace",
    fontSize: "12px",
    color: "var(--text, #e2e8f0)",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  };

  const headerStyle: any = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px 6px",
    borderBottom: "1px solid var(--border, #334155)",
    flexShrink: 0,
  };

  const filterRowStyle: any = {
    display: "flex",
    gap: "6px",
    padding: "6px 10px",
    borderBottom: "1px solid var(--border, #334155)",
    flexShrink: 0,
  };

  const listStyle: any = {
    flex: 1,
    overflowY: "auto",
    padding: "6px 8px",
  };

  const footerStyle: any = {
    padding: "6px 10px",
    borderTop: "1px solid var(--border, #334155)",
    flexShrink: 0,
  };

  const cardStyle = (r: Reminder): any => ({
    background: "var(--surface2, #1e293b)",
    border: "1px solid var(--border, #334155)",
    borderRadius: "6px",
    padding: "8px 10px",
    marginBottom: "6px",
    opacity: (!r.active || r.paused) ? 0.6 : 1,
    position: "relative",
  });

  const btnStyle: any = {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "2px 4px",
    color: "var(--text-muted, #94a3b8)",
    fontSize: "13px",
  };

  const primaryBtnStyle: any = {
    background: "var(--accent, #3b82f6)",
    border: "none",
    borderRadius: "4px",
    padding: "4px 10px",
    color: "#fff",
    cursor: "pointer",
    fontSize: "12px",
  };

  const filterBtnStyle = (active: boolean): any => ({
    background: active ? "var(--accent, #3b82f6)" : "var(--surface2, #1e293b)",
    border: "1px solid var(--border, #334155)",
    borderRadius: "4px",
    padding: "2px 8px",
    color: active ? "#fff" : "var(--text-muted, #94a3b8)",
    cursor: "pointer",
    fontSize: "11px",
  });

  const inputStyle: any = {
    background: "var(--surface2, #1e293b)",
    border: "1px solid var(--border, #334155)",
    borderRadius: "4px",
    padding: "4px 8px",
    color: "var(--text, #e2e8f0)",
    fontSize: "12px",
    width: "100%",
    boxSizing: "border-box",
  };

  const labelStyle: any = { display: "block", marginBottom: "2px", color: "var(--text-muted, #94a3b8)", fontSize: "11px" };

  const formSectionStyle: any = { marginBottom: "10px" };

  // ── Render: Form ─────────────────────────────────────────────

  if (showForm) {
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>
          <span style={{ fontWeight: "bold" }}>{editingId ? "✏ Edit Reminder" : "➕ New Reminder"}</span>
          <button style={btnStyle} onClick={() => { setShowForm(false); setError(null); }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>

          {error && <div style={{ color: "var(--err, #ef4444)", marginBottom: "8px", fontSize: "11px" }}>⚠ {error}</div>}

          <div style={formSectionStyle}>
            <label style={labelStyle}>Title (optional)</label>
            <input style={inputStyle} value={form.title} onChange={(e: any) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Lint check" />
          </div>

          <div style={formSectionStyle}>
            <label style={labelStyle}>Text *</label>
            <textarea
              style={{ ...inputStyle, height: "70px", resize: "vertical" }}
              value={form.text}
              onChange={(e: any) => setForm({ ...form, text: e.target.value })}
              placeholder="Reminder body (markdown)"
            />
          </div>

          <div style={{ borderTop: "1px solid var(--border, #334155)", margin: "8px 0 10px", opacity: 0.4 }} />

          <div style={formSectionStyle}>
            <label style={labelStyle}>When (Trigger)</label>
            <select style={inputStyle} value={form.triggerType} onChange={(e: any) => setForm({ ...form, triggerType: e.target.value })}>
              <option value="always">always</option>
              <option value="until_dismissed">until_dismissed</option>
              <option value="once">once</option>
              <option value="n_turns">n_turns</option>
              <option value="until_date">until_date</option>
              <option value="after_date">after_date</option>
            </select>
            {form.triggerType === "n_turns" && (
              <input style={{ ...inputStyle, marginTop: "4px" }} type="number" min="1" value={form.triggerRemaining}
                onChange={(e: any) => setForm({ ...form, triggerRemaining: e.target.value })}
                placeholder="Number of turns" />
            )}
            {(form.triggerType === "until_date" || form.triggerType === "after_date") && (
              <input style={{ ...inputStyle, marginTop: "4px" }} type="datetime-local"
                value={form.triggerDate}
                onChange={(e: any) => setForm({ ...form, triggerDate: e.target.value })} />
            )}
          </div>

          <div style={formSectionStyle}>
            <label style={labelStyle}>Where (Scope)</label>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
              <label><input type="checkbox" checked={form.scopeAll} onChange={(e: any) => setForm({ ...form, scopeAll: e.target.checked })} /> all</label>
              <label><input type="checkbox" checked={form.scopeMain} disabled={form.scopeAll} onChange={(e: any) => setForm({ ...form, scopeMain: e.target.checked })} /> main</label>
            </div>
            <input style={{ ...inputStyle, marginBottom: "4px" }} disabled={form.scopeAll} value={form.scopePattern}
              onChange={(e: any) => setForm({ ...form, scopePattern: e.target.value })}
              placeholder="Glob pattern: actor-coder-*" />
            <input style={{ ...inputStyle, marginBottom: "4px" }} disabled={form.scopeAll} value={form.scopeRegex}
              onChange={(e: any) => setForm({ ...form, scopeRegex: e.target.value })}
              placeholder="Regex: ^actor-" />
            <input style={inputStyle} disabled={form.scopeAll} value={form.scopeLiteral}
              onChange={(e: any) => setForm({ ...form, scopeLiteral: e.target.value })}
              placeholder="Literal IDs (comma-separated)" />
          </div>

          <div style={formSectionStyle}>
            <label style={labelStyle}>How (Format)</label>
            <div style={{ display: "flex", gap: "12px", marginBottom: "4px" }}>
              <label><input type="radio" name="style" value="plain" checked={form.formatStyle === "plain"} onChange={() => setForm({ ...form, formatStyle: "plain" })} /> plain</label>
              <label><input type="radio" name="style" value="system-reminder" checked={form.formatStyle === "system-reminder"} onChange={() => setForm({ ...form, formatStyle: "system-reminder" })} /> system-reminder</label>
            </div>
            <select style={inputStyle} value={form.formatSeverity} onChange={(e: any) => setForm({ ...form, formatSeverity: e.target.value })}>
              <option value="">no severity</option>
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="important">important</option>
            </select>
          </div>

          <div style={formSectionStyle}>
            <label>
              <input type="checkbox" checked={form.gatingEnabled} onChange={(e: any) => setForm({ ...form, gatingEnabled: e.target.checked })} />
              {" "}Keyword gating
            </label>
            {form.gatingEnabled && (
              <>
                <input style={{ ...inputStyle, marginTop: "4px" }} value={form.gatingKeywords}
                  onChange={(e: any) => setForm({ ...form, gatingKeywords: e.target.value })}
                  placeholder="commit, PR, deploy (comma-separated)" />
                <label style={{ marginTop: "4px", display: "block", fontSize: "11px" }}>
                  <input type="checkbox" checked={form.gatingCaseSensitive} onChange={(e: any) => setForm({ ...form, gatingCaseSensitive: e.target.checked })} />
                  {" "}case sensitive
                </label>
              </>
            )}
          </div>

        </div>
        <div style={{ ...footerStyle, display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button style={{ ...btnStyle, border: "1px solid var(--border, #334155)", borderRadius: "4px", padding: "4px 10px" }}
            onClick={() => { setShowForm(false); setError(null); }}>Cancel</button>
          <button style={primaryBtnStyle} onClick={handleSubmit}>{editingId ? "Save" : "Create"}</button>
        </div>
      </div>
    );
  }

  // ── Render: Confirm delete ─────────────────────────────────────

  if (confirmDeleteId) {
    return (
      <div style={panelStyle}>
        <div style={{ padding: "20px", textAlign: "center" }}>
          <div style={{ marginBottom: "12px" }}>🗑 Delete reminder <strong>{confirmDeleteId}</strong>?</div>
          <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
            <button style={{ ...btnStyle, border: "1px solid var(--border, #334155)", borderRadius: "4px", padding: "4px 12px" }}
              onClick={() => setConfirmDeleteId(null)}>Cancel</button>
            <button style={{ ...primaryBtnStyle, background: "var(--err, #ef4444)" }}
              onClick={() => handleDelete(confirmDeleteId)}>Delete</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Confirm clear ──────────────────────────────────────

  if (showClearConfirm) {
    return (
      <div style={panelStyle}>
        <div style={{ padding: "20px", textAlign: "center" }}>
          <div style={{ marginBottom: "12px" }}>🧹 Clear all dismissed reminders?</div>
          <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
            <button style={{ ...btnStyle, border: "1px solid var(--border, #334155)", borderRadius: "4px", padding: "4px 12px" }}
              onClick={() => setShowClearConfirm(false)}>Cancel</button>
            <button style={{ ...primaryBtnStyle, background: "var(--warn, #f59e0b)", color: "#000" }}
              onClick={handleClearDismissed}>Clear dismissed</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: Main list ─────────────────────────────────────────

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontWeight: "bold" }}>
          ⏰ Reminders
          {activeCount > 0 && (
            <span style={{ marginLeft: "6px", background: "var(--accent, #3b82f6)", borderRadius: "10px", padding: "1px 7px", fontSize: "10px" }}>
              {activeCount} active
            </span>
          )}
        </span>
        <button style={primaryBtnStyle} onClick={handleNew}>+ New</button>
      </div>

      {/* Filter row */}
      <div style={filterRowStyle}>
        {(["active", "paused", "dismissed", "all"] as FilterType[]).map(f => (
          <button key={f} style={filterBtnStyle(filter === f)} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>

      {/* List */}
      <div style={listStyle}>
        {filtered.length === 0 && (
          <div style={{ color: "var(--text-muted, #94a3b8)", textAlign: "center", padding: "20px 0" }}>
            {filter === "active" ? "No active reminders. Click + New to add one." : `No ${filter} reminders.`}
          </div>
        )}

        {filtered.map(r => (
          <div key={r.id} style={cardStyle(r)}>
            {/* Row 1: icon + title + buttons */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
              <span>
                <span style={{ marginRight: "4px", ...(r.format.severity ? { color: SEVERITY_COLOR[r.format.severity] } : {}) }}>
                  {severityIcon(r)}
                </span>
                <span style={{ fontWeight: "bold" }}>
                  {r.format.title ?? r.text.slice(0, 40)}
                </span>
              </span>
              <span style={{ display: "flex", gap: "2px" }}>
                {r.active && !r.paused && (
                  <button title="Pause" style={btnStyle} onClick={() => handleAction("pause", r.id)}>⏸</button>
                )}
                {r.paused && (
                  <button title="Resume" style={btnStyle} onClick={() => handleAction("resume", r.id)}>▶</button>
                )}
                {!r.active && (
                  <button title="Resume" style={btnStyle} onClick={() => handleAction("resume", r.id)}>↩</button>
                )}
                {r.active && (
                  <button title="Dismiss" style={btnStyle} onClick={() => handleAction("dismiss", r.id)}>✓</button>
                )}
                <button title="Edit" style={btnStyle} onClick={() => handleEdit(r)}>✏</button>
                <button title="Delete" style={{ ...btnStyle, color: "var(--err, #ef4444)" }} onClick={() => setConfirmDeleteId(r.id)}>🗑</button>
              </span>
            </div>

            {/* Row 2: text preview */}
            <div style={{ color: "var(--text-muted, #94a3b8)", marginBottom: "4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {r.text.slice(0, 80)}{r.text.length > 80 ? "…" : ""}
            </div>

            {/* Row 3: meta */}
            <div style={{ fontSize: "10px", color: "var(--text-muted, #94a3b8)", display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <span>{triggerSummary(r.trigger)}</span>
              <span>·</span>
              <span>{scopeSummary(r.scope)}</span>
              {gatingLabel(r.gating) && <><span>·</span><span>{gatingLabel(r.gating)}</span></>}
              {r.triggeredCount > 0 && <><span>·</span><span>×{r.triggeredCount}</span></>}
              {r.lastTriggeredAt && <><span>·</span><span>{relativeTime(r.lastTriggeredAt)}</span></>}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={footerStyle}>
        <button style={{ ...btnStyle, fontSize: "11px" }} onClick={() => setShowClearConfirm(true)}>
          🧹 Clear dismissed
        </button>
      </div>
    </div>
  );
}
```

Write to: `~/.jarvis/plugins/jarvis-plugin-reminders/renderers/ReminderRenderer.tsx`

- [ ] **Step 2: Commit**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-reminders && git add -A && git commit -m "feat: ReminderRenderer HUD panel with filter, cards, and create/edit form"
```

---

## Task 8: Install and smoke test

**Files:** none (verification only)

- [ ] **Step 1: Install plugin via JARVIS**

Call tool: `plugin_install` with repo path `github.com/giovanibarili/jarvis-plugin-reminders`

> **If the plugin is local-only** (not pushed to GitHub yet), use jarvis_eval to load it directly:
> ```javascript
> // In jarvis_eval:
> const pm = pieces.find(p => p.id === "plugin-manager");
> await pm.installLocalPlugin("/Users/giovani.barili/.jarvis/plugins/jarvis-plugin-reminders");
> ```

- [ ] **Step 2: Verify plugin loaded**

Call tool: `piece_list`

Expected: `reminder-manager` piece appears with status `running`.

- [ ] **Step 3: Verify tools registered**

Call tool: `session_get_tools` with filter `reminder`

Expected: 8 tools appear — `reminder_create`, `reminder_list`, `reminder_get`, `reminder_update`, `reminder_delete`, `reminder_dismiss`, `reminder_pause`, `reminder_resume`.

- [ ] **Step 4: Run Scenario 1 — create + inject**

```
reminder_create({
  text: "Functional test reminder — always inject",
  trigger: { type: "always" },
  scope: "main"
})
```

Expected: `{ success: true, reminder: { id: "r-1", active: true, paused: false, triggeredCount: 0 } }`

Then call `session_get_system` — verify "Functional test reminder" appears in the system context.

- [ ] **Step 5: Run all 20 BDD scenarios from functional-test.md**

Read `~/.jarvis/plugins/jarvis-plugin-reminders/functional-test.md` and execute every scenario.

Report PASS/FAIL for each individually. Do NOT proceed to commit if any scenario fails.

- [ ] **Step 6: Final commit**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-reminders && git add -A && git commit -m "feat: v0.1.0 complete — all 20 functional test scenarios passing"
```

---

## Self-Review Checklist

Before calling this plan complete:

- [ ] All 8 reminder tools registered and functional
- [ ] `systemContext(sessionId)` returns `""` when no reminders match (Scenario 18)
- [ ] `once` + `n_turns` auto-dismiss correctly (Scenarios 2, 3)
- [ ] Scope glob matching works for `actor-coder-*` (Scenario 5)
- [ ] Keyword gating blocks injection when keyword absent (Scenario 7)
- [ ] Owner-only enforced on mutations via LLM tools (Scenario 9)
- [ ] HTTP routes bypass owner-only (Scenario 15)
- [ ] Corrupted `.md` files don't block boot (Scenario 17)
- [ ] `reminder_update` does full replace of nested objects (Scenario 20)
- [ ] HUD panel renders and updates live (Scenario 14)
- [ ] Files persist in `~/.jarvis/reminders/` (Scenario 13)

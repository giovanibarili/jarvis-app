# Design — `jarvis-plugin-reminders`

**Date:** 2026-05-07  
**Status:** Approved  
**Author:** brainstorming session (giovanibarili + JARVIS)

---

## 1. Vision & Responsibilities

A generic reminder engine: small blocks of text injected into the system prompt (Block 1 — dynamic plugin context) on each turn, according to a **configurable injection policy** per reminder.

The plugin is analogous to `cron_create` in philosophy: one engine, many policies. No hardcoded types.

**Actors:**
- **LLM** — creates/manages reminders via 8 capability tools (`reminder_clear` exposed only via HTTP/HUD)
- **User** — manages reminders via HUD panel (full CRUD + form)
- **Engine** — evaluates injection policy on every `systemContext(sessionId)` call

**Persistence:** one `.md` file per reminder in `~/.jarvis/reminders/`, with YAML frontmatter (structured policy) and markdown body (reminder text). Parser: `gray-matter` (same as Mnemosyne plugin).

---

## 2. Data Model

### 2.1 TypeScript types

```ts
// pieces/types.ts

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
  style: "plain" | "system-reminder";              // wrap in <system-reminder>?
  severity?: "info" | "warning" | "important";    // affects icon/header
  title?: string;                                  // optional title
}

// ─── Gating (Dimension D — extra condition) ───────────────────────
export type Gating =
  | { type: "keyword"; any: string[]; caseSensitive?: boolean };
  // extensible: future strategies (regex, session_age, etc.) add new union members

// ─── Reminder ─────────────────────────────────────────────────────
export interface Reminder {
  id: string;                                      // "r-1", "r-2"…
  sessionIdOwner: string;                          // creating session
  text: string;                                    // markdown body

  createdAt: string;                               // ISO 8601
  updatedAt: string;

  trigger: Trigger;
  scope: Scope;
  format: Format;
  gating?: Gating;

  // Runtime state (3 orthogonal flags)
  active: boolean;                                 // false = dismissed
  paused: boolean;                                 // true = temporarily suspended
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

### 2.2 Disk format (`~/.jarvis/reminders/r-1.md`)

```markdown
---
id: r-1
sessionIdOwner: main
createdAt: 2026-05-07T14:30:00Z
updatedAt: 2026-05-07T14:30:00Z
active: true
paused: false
triggeredCount: 3
lastTriggeredAt: 2026-05-07T15:12:00Z
trigger:
  type: until_dismissed
scope:
  - main
  - match: "actor-coder-*"
format:
  style: system-reminder
  severity: warning
  title: Lint check
gating:
  type: keyword
  any: [commit, "abrir PR", "create PR"]
  caseSensitive: false
---

Always run `npm run lint` and `npm test` before committing or opening a PR.
If either fails, stop and fix before proceeding.
```

The reminder `text` is the **markdown body below the frontmatter**. Manual editing is natural and supported.

---

## 3. Injection Pipeline & Lifecycle

### 3.1 When it runs

`ProviderRouter.getPluginContext(sessionId)` → `plugin-manager.pluginPieceContext(sessionId)` → `ReminderPiece.systemContext(sessionId)`. Called on every API call (per turn).

Output lands in Block 1 (cacheable). Identical output → cache hit. Changed output (because a trigger state changed) → cache miss. Stateful triggers (n_turns, once) inherently cause cache invalidation — this is acceptable.

### 3.2 Injection algorithm

```
For each reminder R in memory:
  1. ACTIVE: R.active && !R.paused              → else skip
  2. TRIGGER: matchTrigger(R.trigger, now)       → else skip
       - always               → pass
       - until_dismissed      → pass
       - once                 → pass if triggeredCount === 0
       - n_turns              → pass if remaining > 0
       - until_date           → pass if now < date
       - after_date           → pass if now >= date
  3. SCOPE: matchScope(R.scope, sessionId)       → else skip
  4. GATING: matchGating(R.gating, lastPrompt)   → else skip

For each reminder in toInject:
  - triggeredCount += 1
  - lastTriggeredAt = now
  - once       → active = false
  - n_turns    → remaining -= 1; if 0 → active = false
  - until_date → if now >= date → active = false
  - flush to disk (debounced ~300ms)

Render all toInject → return string (or "" if none)
```

Returns `""` if nothing matches → **no cache invalidation** on quiet turns.

### 3.3 Last user prompt capture (for gating)

```ts
this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
  if (msg.target && typeof msg.text === "string") {
    this.lastPrompts.set(msg.target, msg.text);
  }
});
```

Map `sessionId → lastPromptText`. Gating reads from this map.

Edge case: no prompt yet → gating does **not** match. Keyword-gated reminders are silent on the first turn.

### 3.4 Render format

```
## Active Reminders

<system-reminder severity="warning">
**Lint check**

Always run `npm run lint` and `npm test` before committing…
</system-reminder>

> [info] Project context: debugging bug X until resolved

<system-reminder>
PR #123 still waiting for review.
</system-reminder>
```

Rules:
- `format.style === "system-reminder"` → `<system-reminder [severity="…"]>…</system-reminder>`
- `format.style === "plain"` → blockquote with optional `[info|warning|important]` prefix
- `format.title` → first line **bold**
- `text` rendered as-is (markdown)

### 3.5 Scope & gating matching

```ts
function matchScope(scope: Scope, sessionId: string): boolean {
  const entries = Array.isArray(scope) ? scope : [scope];
  return entries.some(entry => {
    if (entry === "all") return true;
    if (entry === "main") return sessionId === "main";
    if (typeof entry === "string") return sessionId === entry;
    if ("match" in entry) return globToRegex(entry.match).test(sessionId);
    if ("regex" in entry) return new RegExp(entry.regex).test(sessionId);
    return false;
  });
}

function matchGating(gating: Gating | undefined, lastPrompt: string | undefined): boolean {
  if (!gating) return true;
  if (!lastPrompt) return false;
  const text = gating.caseSensitive ? lastPrompt : lastPrompt.toLowerCase();
  return gating.any.some(kw => {
    const needle = gating.caseSensitive ? kw : kw.toLowerCase();
    return text.includes(needle);
  });
}
```

`globToRegex`: `*` → `.*`, escapes everything else. No `**` or `?` support.

### 3.6 Boot & persistence

**Boot:**
1. `mkdir -p ~/.jarvis/reminders/`
2. `readdirSync` filtering `r-*.md`
3. `gray-matter.read()` each — on parse error: log warn, rename to `.broken`, skip
4. Populate in-memory Map
5. `idCounter = max(existingIds) + 1`
6. Subscribe `ai.request`
7. Register capabilities + HTTP routes
8. Publish HUD

**Writes:**
- `dirty: Set<reminderId>` accumulates changes
- `setTimeout(flush, 300)` rescheduled on each mutation
- `flush()`: write `.md` per dirty id (or `rm` if deleted)
- `stop()`: synchronous final flush

**No fs.watch in MVP.** Manual edits reflected after `plugin_update` or tool-based edit. Extensible later.

---

## 4. Capabilities (8 LLM Tools)

All mutations are **owner-only** (sessionIdOwner check). HTTP routes bypass for user-driven HUD actions.

| Tool | Owner-only | Description |
|---|---|---|
| `reminder_create` | — | Create reminder with full policy |
| `reminder_list` | — | List all, with optional filters |
| `reminder_get` | — | Full details by ID |
| `reminder_update` | ✓ | Update any field (nested = full replace) |
| `reminder_delete` | ✓ | Delete permanently |
| `reminder_dismiss` | ✓ | `active=false` — "I've seen this, done" |
| `reminder_pause` | ✓ | `paused=true` — suspend without dismissing |
| `reminder_resume` | ✓ | `paused=false, active=true` — reactivate |
| ~~`reminder_clear`~~ | HTTP only | Bulk delete — **not exposed to LLM** |

### 4.1 `reminder_create` schema (key fields)

```jsonc
{
  text: string,                // required — markdown, keep short
  trigger: Trigger,            // required
  scope: Scope,                // required ("main" | "all" | literal | {match} | {regex} | [...])
  format?: Format,             // default: { style: "plain" }
  gating?: Gating              // optional keyword gating
}
```

### 4.2 `reminder_list` filters

```jsonc
{
  status?: "active" | "paused" | "dismissed",
  sessionIdOwner?: string,        // filter by owner
  matchesSession?: string         // preview: which reminders would inject in this session?
}
```

`matchesSession` runs scope-matching without side effects — useful for "what would actor-alice see?"

### 4.3 Error format

```ts
{ success: false, error: string }
```

Standard errors:
- `"Reminder <id> not found"`
- `"Reminder <id> belongs to session \"<owner>\" — only its owner can <action> it."`
- `"text is required"` / `"trigger is required"` / `"scope is required"`
- `"Invalid trigger: ..."` / `"Invalid scope: ..."` / `"Invalid gating: ..."`
- `"Date must be ISO 8601: ..."`

### 4.4 HTTP routes (HUD bypass)

| Method | Path | Body | Action |
|---|---|---|---|
| POST | `/plugins/reminders/create` | `{sessionIdOwner?, text, trigger, scope, format?, gating?}` | Create |
| POST | `/plugins/reminders/update/<id>` | partial fields | Update |
| POST | `/plugins/reminders/delete/<id>` | — | Delete |
| POST | `/plugins/reminders/dismiss/<id>` | — | `active=false` |
| POST | `/plugins/reminders/pause/<id>` | — | `paused=true` |
| POST | `/plugins/reminders/resume/<id>` | — | `paused=false, active=true` |
| POST | `/plugins/reminders/clear` | `{sessionIdOwner?, all?: bool}` | Bulk delete (HUD only) |
| GET  | `/plugins/reminders/list` | query: `status=`, `owner=` | List |

`/clear` semantics:
- Without `sessionIdOwner`: clear all dismissed system-wide
- With `sessionIdOwner`: clear dismissed for that owner
- `all: true`: ignore status, delete everything (HUD must confirm before calling)

---

## 5. HUD / Renderer

### 5.1 Panel layout

Anchored panel (non-ephemeral). Default position: `{ x: 1240, y: 850 }`, size `{ 540, 420 }` — below Tasks panel to avoid overlap. Persists in settings.

```
┌─────────────────────────────────────────────────┐
│ ⏰ Reminders          [3 active]  [+ New]       │
├─────────────────────────────────────────────────┤
│ Filter: ◉ Active  ○ Paused  ○ Dismissed  ○ All  │
├─────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────┐   │
│ │ 🟡 Lint check                  ⏸ ✓ ✏ 🗑   │   │
│ │ Always run npm run lint before commit…    │   │
│ │ until_dismissed · main + actor-coder-*    │   │
│ │ keyword: commit, PR · triggered 3× · 2m  │   │
│ └───────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────┐   │
│ │ ⚪ PAUSED — daily standup       ▶ ✓ ✏ 🗑  │   │
│ └───────────────────────────────────────────┘   │
│                                                  │
│ [Clear dismissed]                                │
└─────────────────────────────────────────────────┘
```

**Card per reminder:**
- Line 1: severity icon + title/text preview + action buttons (⏸/▶, ✓, ✏, 🗑)
- Line 2: text preview (~80 chars, expandable on click)
- Line 3: meta — `<trigger> · <scope-summary> · <gating-summary> · triggered Nx · <relative time>`

**Severity icons:** 🟢 info, 🟡 warning, 🔴 important, ⚪ none/paused, ✅ dismissed

**Action buttons (icon-only):**
- `⏸`/`▶` — pause/resume toggle
- `✓` — dismiss
- `✏` — edit (open form prefilled)
- `🗑` — delete (confirm modal)

### 5.2 Form (create/edit)

Inline modal over the panel. Sections:
1. **Title** (optional text input)
2. **Text** (multiline textarea, required)
3. **When (Trigger)** — type dropdown + conditional fields:
   - `n_turns` → integer input for `remaining`
   - `until_date`/`after_date` → datetime-local input
4. **Where (Scope)** — checkboxes for `main`, `all`, plus dynamic rows for literal IDs, glob patterns, regex
5. **How (Format)** — style radio (plain/system-reminder) + severity dropdown
6. **Gating (optional)** — checkbox to enable + comma-separated keywords textarea + case-sensitive toggle

**Submit:** POST create or update. On success: close form, refresh via `/list`.

### 5.3 Live updates

- **Push:** `publishToHud()` after every mutation (create/update/delete/dismiss/pause/resume/inject-with-side-effects)
- **Condition:** only publish if state actually changed (skip on quiet turns with no side effects)

### 5.4 Severity colors

Uses existing CSS custom properties from `hud.css`:
- `info` → `var(--ok)` (blue)
- `warning` → `var(--warn)` (amber)
- `important` → `var(--err)` (red)
- Paused/dismissed cards → opacity 0.5

---

## 6. File Structure

```
~/.jarvis/plugins/jarvis-plugin-reminders/
├── plugin.json                      # manifest
├── package.json                     # deps: gray-matter
├── package-lock.json
├── README.md
├── CODEOWNERS
├── context.md                       # static LLM instructions for the 8 tools
├── functional-test.md               # 20 BDD scenarios
├── pieces/
│   ├── index.ts                     # exports createPieces(ctx)
│   ├── types.ts                     # Reminder, Trigger, Scope, Format, Gating
│   ├── reminder-store.ts            # disk I/O: load/save/delete .md via gray-matter
│   ├── reminder-engine.ts           # pure functions: matchTrigger, matchScope,
│   │                                #   matchGating, render, applyTriggerSideEffects
│   └── reminder-piece.ts            # Piece: lifecycle, capabilities, HTTP, HUD
└── renderers/
    └── ReminderRenderer.tsx         # panel + filter + cards + form
```

**Separation of concerns:**
- `reminder-store.ts` — only touches disk (load/save/delete, debounce here)
- `reminder-engine.ts` — pure functions, no side effects, fully unit-testable
- `reminder-piece.ts` — orchestrates: bus subscribe, capabilities, HTTP routes, HUD publish

---

## 7. Edge Cases

| Case | Handling |
|---|---|
| Corrupted `.md` on boot | Warn, rename to `.broken`, skip — other reminders unaffected |
| ID counter after deletes | Boot reads max existing N, counter starts at max+1 (no ID reuse) |
| `until_date` in the past | Never injects. Shown in HUD with "expired" badge. Not auto-dismissed |
| `after_date` in the past | Equivalent to `always` from that moment on |
| Empty `text` | Error: "text is required" |
| Empty/missing `scope` | Error: "scope is required" |
| Invalid scope entry (bad regex) | Validation error on create/update; runtime → log warn, treat as `false`, show HUD badge ⚠️ |
| First turn (no last prompt) | Keyword-gated reminders don't inject. Correct — nothing to match |
| `lastPrompts` map growth | Prune if > 100 entries on each new insert (cosmetic guard) |
| `reminder_clear` bulk delete | HUD shows confirm modal before POST. Backend trusts caller |
| `once` auto-dismiss | Renders on the triggering turn, then `active=false` immediately after |

---

## 8. Logging

Following plugin conventions (no Pino, direct `console.*`):

```
[reminders] loaded N reminders (X active, Y paused, Z dismissed)
[reminders] r-3 auto-dismissed (once trigger fired)
[reminders] r-3 updated by main
[reminders] failed to parse r-7.md: <reason> — renamed to .broken
```

No per-turn injection logging at info level (too noisy). Optional debug-level aggregate.

---

## 9. Token Cost Guidance (for context.md)

The following advice will be injected into `context.md` so the LLM uses reminders efficiently:

- Prefer `until_dismissed` for open-ended reminders (behavioral rules, active context anchors)
- Use `n_turns` for short-lived context (next 3–5 turns)
- Use `gating: keyword` aggressively — reminder costs zero tokens on non-matching turns
- Use `format.style: "plain"` unless emphasis is genuinely needed
- Keep `text` short — reminders are policies, not documentation
- `reminder_dismiss` immediately after the underlying concern is resolved

---

## 10. Functional Test Scenarios (summary — full list in functional-test.md)

| # | Scenario |
|---|---|
| 1 | Create reminder with `always` trigger → injected, file written, count incremented |
| 2 | `once` trigger → injected once, then auto-dismissed |
| 3 | `n_turns` trigger → remaining decrements, auto-dismiss at 0 |
| 4 | Scope `main` → renders for main, not for actor-alice |
| 5 | Scope glob `actor-coder-*` → matches/not matches |
| 6 | Scope array union → matches any member |
| 7 | Keyword gating → blocks/passes based on last user prompt |
| 8 | `reminder_dismiss` → active=false, not rendered |
| 9 | Owner-only: dismiss by wrong session → error |
| 10 | `reminder_pause`/`resume` → suspend/reactivate without dismissing |
| 11 | `until_date` in past → not rendered |
| 12 | `after_date` in future → not rendered |
| 13 | Restart persistence → all reminders survive |
| 14 | HUD panel shows reminder cards after create |
| 15 | HTTP create bypasses owner-only → creates with given sessionIdOwner |
| 16 | HTTP `/clear` (no `all`) removes only dismissed |
| 17 | Corrupted `.md` → other reminders still load, file renamed `.broken` |
| 18 | No matching reminders → `systemContext` returns `""` |
| 19 | `format.style: "system-reminder"` → output wrapped in `<system-reminder>` |
| 20 | `reminder_update` nested object → full replace, not merge |

---

## 11. Implementation Order

1. Scaffold: `plugin.json`, `package.json`, dirs
2. `types.ts` + `reminder-store.ts`
3. `reminder-engine.ts` (pure functions — TDD)
4. `reminder-piece.ts` skeleton (lifecycle + bus subscribe)
5. Capabilities (8 LLM tools)
6. HTTP routes (incl. `/clear` HTTP-only)
7. `publishToHud()`
8. `ReminderRenderer.tsx` (list → filter → cards → form → modals)
9. `README.md` + `context.md` + `functional-test.md`
10. Install + run all 20 functional test scenarios

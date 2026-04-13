# Plugin Phase 2 — Dynamic Pieces & Renderers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable plugins to contribute TypeScript pieces and TSX renderers that load dynamically at runtime, validated with the voice plugin.

**Architecture:** Monorepo with `@jarvis/core` shared package. PluginManager dynamically imports plugin entry files via tsx. Backend compiles TSX renderers with esbuild and serves via HTTP. Frontend lazy-loads renderer components.

**Tech Stack:** TypeScript, tsx (on-the-fly compilation), esbuild (renderer compilation), React lazy/Suspense, npm workspaces.

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `packages/core/package.json` | @jarvis/core package definition |
| `packages/core/tsconfig.json` | TypeScript config for core package |
| `packages/core/src/index.ts` | Re-exports all core types and classes |
| `packages/core/src/piece.ts` | Piece interface, HudPieceData, HUD_TOPICS (extracted from app) |
| `packages/core/src/bus.ts` | EventBus class (extracted from app) |
| `packages/core/src/types.ts` | BusMessage, event types, EventHandler (extracted from app) |
| `packages/core/src/tools.ts` | ToolDefinition, ToolHandler, ToolRegistry interface (new interface) |
| `packages/core/src/plugin.ts` | PluginContext, PluginManifest, JarvisPlugin interfaces |
| `app/` | All current src/, ui/, tools/ moved here |

### Modified files (after move to app/)

| File | Change |
|------|--------|
| `app/src/core/bus.ts` | Re-export from @jarvis/core |
| `app/src/core/piece.ts` | Re-export from @jarvis/core |
| `app/src/core/types.ts` | Re-export from @jarvis/core |
| `app/src/core/plugin-manager.ts` | Add piece loading, renderer registration, unload on disable |
| `app/src/core/piece-manager.ts` | Add registerDynamic(), unregisterDynamic() |
| `app/src/core/hud-state.ts` | Pass renderer metadata in getState() |
| `app/src/server.ts` | Add /plugins/:name/renderers/:file.js endpoint |
| `app/src/main.ts` | Pass pieceManager to PluginManager constructor |
| `app/package.json` | Add workspace dep on @jarvis/core, add esbuild dep |
| `app/ui/src/components/HudRenderer.tsx` | Add plugin renderer lazy loading with fallback |
| `app/ui/src/components/renderers/index.ts` | Export pluginRenderers map |
| `package.json` (root) | Workspaces config |
| `tsconfig.base.json` (root) | Shared compiler options |

### Voice plugin files (~/dev/personal/jarvis-plugin-voice/)

| File | Change |
|------|--------|
| `package.json` | Create — peerDependency on @jarvis/core |
| `plugin.json` | Update capabilities + add entry field |
| `pieces/index.ts` | Create — createPieces() factory |
| `pieces/voice-piece.ts` | Create — VoicePiece adapted from deleted code |
| `renderers/VoiceRenderer.tsx` | Create — voice status/controls panel |

---

## Task 1: Create @jarvis/core package

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/bus.ts`
- Create: `packages/core/src/piece.ts`
- Create: `packages/core/src/tools.ts`
- Create: `packages/core/src/plugin.ts`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@jarvis/core",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "peerDependencies": {
    "typescript": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create src/types.ts**

Extract from `src/core/types.ts`. Copy the full file content — BusMessage, all event interfaces, EventHandler type. Remove the import of ToolCall/ToolResult (those move to tools.ts).

```typescript
// packages/core/src/types.ts

export interface BusMessage {
  id: string;
  timestamp: number;
  sessionId: string;
  componentId: string;
}

export interface InputPromptEvent extends BusMessage {
  text: string;
  replyTo?: string;
}

export interface StreamDeltaEvent extends BusMessage {
  text: string;
}

export interface StreamCompleteEvent extends BusMessage {
  fullText: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface StreamErrorEvent extends BusMessage {
  error: string;
}

export interface ApiUsageEvent extends BusMessage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model: string;
}

export interface ComponentLifecycleEvent extends BusMessage {
  name: string;
  status: string;
}

export interface HealthAlertEvent extends BusMessage {
  pieceId: string;
  pieceName: string;
  healthy: boolean;
  detail: string;
}

export type EventHandler<T extends BusMessage = BusMessage> = (msg: T) => void | Promise<void>;
```

- [ ] **Step 4: Create src/bus.ts**

Copy EventBus class from `src/core/bus.ts`. Replace logger import with a console.debug fallback (core package has no dependency on pino).

```typescript
// packages/core/src/bus.ts
import type { BusMessage, EventHandler } from "./types.js";

interface Subscription {
  topic: string;
  pattern?: RegExp;
  handler: EventHandler;
}

export class EventBus {
  private subscriptions: Subscription[] = [];
  private eventCount = 0;

  publish<T extends BusMessage>(topic: string, data: Omit<T, "id" | "timestamp">): void {
    const msg = {
      ...data,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    } as T;

    this.eventCount++;

    for (const sub of this.subscriptions) {
      const match = sub.pattern ? sub.pattern.test(topic) : sub.topic === topic;
      if (match) {
        try {
          const result = sub.handler(msg);
          if (result instanceof Promise) {
            result.catch(err => console.error(`bus: handler error on ${topic}:`, err));
          }
        } catch (err) {
          console.error(`bus: handler error (sync) on ${topic}:`, err);
        }
      }
    }
  }

  subscribe<T extends BusMessage>(topic: string, handler: EventHandler<T>): () => void {
    const sub: Subscription = { topic, handler: handler as EventHandler };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  subscribePattern<T extends BusMessage>(pattern: string, handler: EventHandler<T>): () => void {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]+") + "$");
    const sub: Subscription = { topic: pattern, pattern: regex, handler: handler as EventHandler };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  get stats() {
    return { subscriptions: this.subscriptions.length, events: this.eventCount };
  }
}
```

- [ ] **Step 5: Create src/piece.ts**

Copy from `src/core/piece.ts`. Update import to local types.

```typescript
// packages/core/src/piece.ts
import type { EventBus } from "./bus.js";
import type { BusMessage } from "./types.js";

export interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  systemContext?(): string;
}

export type HudPieceType = "panel" | "indicator" | "overlay";

export interface HudPieceData {
  pieceId: string;
  type: HudPieceType;
  name: string;
  status: string;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  visible?: boolean;
  renderer?: { plugin: string; file: string };
}

export interface HudPieceAddEvent extends BusMessage {
  piece: HudPieceData;
}

export interface HudPieceUpdateEvent extends BusMessage {
  pieceId: string;
  data: Record<string, unknown>;
  status?: string;
  visible?: boolean;
}

export interface HudPieceRemoveEvent extends BusMessage {
  pieceId: string;
}

export const HUD_TOPICS = {
  ADD: "hud.piece.add",
  UPDATE: "hud.piece.update",
  REMOVE: "hud.piece.remove",
} as const;
```

Note: `HudPieceData` gains a `renderer?: { plugin: string; file: string }` field for plugin renderers.

- [ ] **Step 6: Create src/tools.ts**

Extract tool interfaces from `src/tools/registry.ts` and `src/ai/types.ts`.

```typescript
// packages/core/src/tools.ts

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: ToolHandler;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ToolResultContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

export interface ToolResult {
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

export interface ToolRegistry {
  register(def: ToolDefinition): void;
  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  execute(calls: ToolCall[]): Promise<ToolResult[]>;
  readonly names: string[];
  readonly size: number;
}
```

- [ ] **Step 7: Create src/plugin.ts**

New file — plugin contract types.

```typescript
// packages/core/src/plugin.ts
import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { ToolRegistry } from "./tools.js";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  entry?: string;
  capabilities?: {
    tools?: boolean;
    pieces?: boolean;
    renderers?: boolean;
    prompts?: boolean;
  };
}

export interface PluginContext {
  bus: EventBus;
  toolRegistry: ToolRegistry;
  config: Record<string, unknown>;
  pluginDir: string;
}

export interface JarvisPlugin {
  createPieces?(ctx: PluginContext): Piece[];
}
```

- [ ] **Step 8: Create src/index.ts**

```typescript
// packages/core/src/index.ts
export * from "./types.js";
export * from "./bus.js";
export * from "./piece.js";
export * from "./tools.js";
export * from "./plugin.js";
```

- [ ] **Step 9: Verify package resolves**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/
git commit -m "feat: create @jarvis/core shared package"
```

---

## Task 2: Set up monorepo workspaces and move app

**Files:**
- Create: `package.json` (root)
- Create: `tsconfig.base.json` (root)
- Move: `src/`, `ui/`, `tools/`, `mcp.json`, `*.md`, `.jarvis/`, `scripts/` → `app/`
- Modify: `app/package.json` (add @jarvis/core dep)
- Modify: `app/tsconfig.json` (extend base)

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "jarvis",
  "private": true,
  "workspaces": ["packages/*", "app"]
}
```

- [ ] **Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  }
}
```

- [ ] **Step 3: Move app files**

```bash
mkdir app
git mv src app/
git mv ui app/
git mv tools app/
git mv mcp.json app/
git mv jarvis-system.md app/
git mv actor-system.md app/
git mv scripts app/
git mv ARCHITECTURE.md app/
git mv README.md app/
```

Move package.json manually (rename, not git mv, because root gets a new one):

```bash
cp package.json app/package.json
# Root package.json is the new workspace root (created in step 1)
```

Move tsconfig:

```bash
git mv tsconfig.json app/tsconfig.json
```

- [ ] **Step 4: Update app/package.json — add @jarvis/core dependency**

Add to dependencies:

```json
"@jarvis/core": "workspace:*"
```

Also add esbuild:

```json
"esbuild": "^0.25.0"
```

Update scripts to reflect new paths:

```json
"scripts": {
  "start": "tsx src/main.ts",
  "client": "tsx src/transport/grpc/client.ts",
  "dev": "tsx watch src/main.ts"
}
```

- [ ] **Step 5: Update app/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Update app/src/core/bus.ts — re-export from @jarvis/core**

Replace entire file:

```typescript
// app/src/core/bus.ts
// Re-export from shared package. App uses the pino-logged version below.
import { log } from "../logger/index.js";
import type { BusMessage, EventHandler } from "@jarvis/core";

interface Subscription {
  topic: string;
  pattern?: RegExp;
  handler: EventHandler;
}

export class EventBus {
  private subscriptions: Subscription[] = [];
  private eventCount = 0;

  publish<T extends BusMessage>(topic: string, data: Omit<T, "id" | "timestamp">): void {
    const msg = {
      ...data,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    } as T;

    this.eventCount++;
    log.debug({ topic, sessionId: msg.sessionId, componentId: msg.componentId, eventId: msg.id }, "bus: publish");

    for (const sub of this.subscriptions) {
      const match = sub.pattern ? sub.pattern.test(topic) : sub.topic === topic;
      if (match) {
        try {
          const result = sub.handler(msg);
          if (result instanceof Promise) {
            result.catch(err => log.error(`bus: handler error on ${topic}: ${err instanceof Error ? err.message + '\n' + err.stack : String(err)}`));
          }
        } catch (err) {
          log.error({ topic, err }, "bus: handler error (sync)");
        }
      }
    }
  }

  subscribe<T extends BusMessage>(topic: string, handler: EventHandler<T>): () => void {
    const sub: Subscription = { topic, handler: handler as EventHandler };
    this.subscriptions.push(sub);
    log.debug({ topic }, "bus: subscribe");
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  subscribePattern<T extends BusMessage>(pattern: string, handler: EventHandler<T>): () => void {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]+") + "$");
    const sub: Subscription = { topic: pattern, pattern: regex, handler: handler as EventHandler };
    this.subscriptions.push(sub);
    log.debug({ pattern }, "bus: subscribePattern");
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  get stats() {
    return { subscriptions: this.subscriptions.length, events: this.eventCount };
  }
}
```

Note: The app keeps its own EventBus with pino logging. The @jarvis/core EventBus is what plugins import. Both implement the same interface. Plugins get the app's real instance injected via PluginContext — they never instantiate their own.

- [ ] **Step 7: Update app/src/core/types.ts — re-export from @jarvis/core + app-specific types**

```typescript
// app/src/core/types.ts
// Re-export shared types
export type {
  BusMessage,
  InputPromptEvent,
  StreamDeltaEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  ApiUsageEvent,
  ComponentLifecycleEvent,
  HealthAlertEvent,
  EventHandler,
} from "@jarvis/core";

// App-specific event types (not in core — depend on app's AI types)
import type { ToolCall, ToolResult } from "../ai/types.js";
import type { BusMessage } from "@jarvis/core";

export interface ToolRequestEvent extends BusMessage {
  calls: ToolCall[];
}

export interface ToolResultEvent extends BusMessage {
  results: ToolResult[];
}

export interface McpConnectedEvent extends BusMessage {
  server: string;
  tools: string[];
}

export interface McpAuthRequiredEvent extends BusMessage {
  server: string;
}
```

- [ ] **Step 8: Update app/src/core/piece.ts — re-export from @jarvis/core**

```typescript
// app/src/core/piece.ts
export type {
  Piece,
  HudPieceType,
  HudPieceData,
  HudPieceAddEvent,
  HudPieceUpdateEvent,
  HudPieceRemoveEvent,
} from "@jarvis/core";

export { HUD_TOPICS } from "@jarvis/core";
```

- [ ] **Step 9: Install dependencies**

```bash
cd /path/to/jarvis-app
npm install
cd app && npm install
```

- [ ] **Step 10: Verify app still compiles**

Run: `cd app && npx tsc --noEmit`
Expected: no errors (all imports resolve via @jarvis/core or local).

- [ ] **Step 11: Verify app starts**

Run: `cd app && npx tsx src/main.ts`
Expected: "JARVIS online" — all pieces start normally.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: monorepo structure with @jarvis/core package"
```

---

## Task 3: Add dynamic piece registration to PieceManager

**Files:**
- Modify: `app/src/core/piece-manager.ts`

- [ ] **Step 1: Add registerDynamic method**

Add after the `disable()` method (line ~81):

```typescript
async registerDynamic(piece: Piece, source: string): Promise<{ ok: boolean; error?: string }> {
  if (this.pieces.has(piece.id)) {
    return { ok: false, error: `Piece ${piece.id} already registered` };
  }

  this.pieces.set(piece.id, piece);

  // If PieceManager already started, start this piece immediately
  if (this.running.size > 0) {
    await piece.start(this.bus);
    this.running.add(piece.id);
  }

  // Create default settings entry
  this.settings = setPieceSettings(this.settings, piece.id, { enabled: true, visible: true });
  save(this.settings);

  log.info({ pieceId: piece.id, source }, "PieceManager: registered dynamic piece");
  return { ok: true };
}

async unregisterDynamic(pieceId: string): Promise<{ ok: boolean; error?: string }> {
  const piece = this.pieces.get(pieceId);
  if (!piece) return { ok: false, error: `Piece ${pieceId} not found` };

  if (this.running.has(pieceId)) {
    await piece.stop();
    this.running.delete(pieceId);
  }

  this.pieces.delete(pieceId);
  // Don't delete settings — preserves layout for re-enable

  log.info({ pieceId }, "PieceManager: unregistered dynamic piece");
  return { ok: true };
}
```

- [ ] **Step 2: Verify PieceManager compiles**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/core/piece-manager.ts
git commit -m "feat: add dynamic piece registration to PieceManager"
```

---

## Task 4: Add renderer metadata to HudState

**Files:**
- Modify: `app/src/core/hud-state.ts`

- [ ] **Step 1: Pass renderer field through getState()**

The `HudPieceData` now has an optional `renderer` field (from @jarvis/core). HudState already stores `HudPieceData` as-is. The only change is in `getState()` — include the renderer info in the output:

In the `getState()` method, update the components mapping (line ~41):

```typescript
const components = [...this.pieces.values()].map(p => ({
  id: p.pieceId,
  name: p.name,
  status: p.status,
  visible: p.visible !== false,
  hudConfig: { type: p.type, draggable: true, resizable: true },
  position: p.position ?? { x: 0, y: 0 },
  size: p.size ?? { width: 200, height: 100 },
  data: p.data,
  renderer: p.renderer,  // <-- add this line
}));
```

- [ ] **Step 2: Commit**

```bash
git add app/src/core/hud-state.ts
git commit -m "feat: pass renderer metadata through HudState"
```

---

## Task 5: Add plugin renderer HTTP endpoint

**Files:**
- Modify: `app/src/server.ts`

- [ ] **Step 1: Add esbuild renderer compilation endpoint**

Add this route handler before the static files section (before line ~103 `// Static files`):

```typescript
// Plugin renderer compilation endpoint
if (req.url?.startsWith("/plugins/") && req.url?.endsWith(".js")) {
  // URL: /plugins/{name}/renderers/{file}.js
  const parts = req.url.split("/");
  // parts = ["", "plugins", name, "renderers", "file.js"]
  if (parts.length === 5 && parts[3] === "renderers") {
    const pluginName = parts[2];
    const fileName = parts[4].replace(".js", ".tsx");
    this.servePluginRenderer(pluginName, fileName, res);
    return;
  }
}
```

Add the `servePluginRenderer` method to HttpServer:

```typescript
private rendererCache = new Map<string, { js: string; mtime: number }>();

private async servePluginRenderer(pluginName: string, fileName: string, res: ServerResponse): Promise<void> {
  const { load: loadSettings } = await import("./core/settings.js");
  const settings = loadSettings();
  const pluginPath = settings.plugins?.[pluginName]?.path;

  if (!pluginPath) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Plugin not found: ${pluginName}` }));
    return;
  }

  const filePath = join(pluginPath, "renderers", fileName);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Renderer not found: ${fileName}` }));
    return;
  }

  const cacheKey = `${pluginName}/${fileName}`;
  const stat = (await import("node:fs")).statSync(filePath);
  const cached = this.rendererCache.get(cacheKey);

  if (cached && cached.mtime === stat.mtimeMs) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(cached.js);
    return;
  }

  try {
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: [filePath],
      bundle: true,
      format: "esm",
      target: "esnext",
      jsx: "automatic",
      write: false,
      external: ["react", "react-dom", "@jarvis/core"],
    });

    const js = result.outputFiles[0].text;
    this.rendererCache.set(cacheKey, { js, mtime: stat.mtimeMs });

    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(js);
  } catch (err) {
    log.error({ pluginName, fileName, err: String(err) }, "HttpServer: renderer compilation failed");
    res.writeHead(500);
    res.end(JSON.stringify({ error: `Compilation failed: ${err}` }));
  }
}
```

Add `statSync` to the fs import at the top of the file (line 2):

```typescript
import { readFileSync, existsSync, statSync } from "node:fs";
```

- [ ] **Step 2: Verify server compiles**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/server.ts
git commit -m "feat: add plugin renderer compilation endpoint"
```

---

## Task 6: Update PluginManager to load pieces and renderers

**Files:**
- Modify: `app/src/core/plugin-manager.ts`
- Modify: `app/src/main.ts`

- [ ] **Step 1: Add PieceManager dependency to PluginManager**

Update constructor and fields:

```typescript
import type { PieceManager } from "./piece-manager.js";
import type { PluginManifest, PluginContext } from "@jarvis/core";

// Update LoadedPlugin interface to track pieces
interface LoadedPlugin {
  name: string;
  manifest: PluginManifest;
  settings: PluginSettings;
  tools: string[];
  prompts: string[];
  pieces: string[];     // piece IDs loaded from this plugin
  renderers: string[];  // renderer file names
}

export class PluginManager implements Piece {
  // ... existing fields ...
  private pieceManager?: PieceManager;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  setPieceManager(pm: PieceManager): void {
    this.pieceManager = pm;
  }
```

- [ ] **Step 2: Add piece loading to loadPlugin**

Add after the prompts loading section (after line ~153):

```typescript
// Load pieces (Phase 2)
if (manifest.capabilities?.pieces && manifest.entry) {
  try {
    const entryPath = join(pluginDir, manifest.entry);
    if (existsSync(entryPath)) {
      const mod = await import(entryPath);
      if (typeof mod.createPieces === "function" && this.pieceManager) {
        const ctx: PluginContext = {
          bus: this.bus,
          toolRegistry: this.registry,
          config: loadSettings().pieces?.[`plugin:${name}`]?.config ?? {},
          pluginDir,
        };
        const pieces: Piece[] = mod.createPieces(ctx);
        for (const piece of pieces) {
          await this.pieceManager.registerDynamic(piece, `plugin:${name}`);
          loaded.pieces.push(piece.id);
        }
        log.info({ name, pieces: loaded.pieces }, "PluginManager: loaded pieces");
      }
    }
  } catch (err) {
    log.error({ name, err: String(err) }, "PluginManager: failed to load pieces");
  }
}

// Discover renderers
if (manifest.capabilities?.renderers) {
  const renderersDir = join(pluginDir, "renderers");
  if (existsSync(renderersDir)) {
    const files = readdirSync(renderersDir).filter(f => f.endsWith(".tsx"));
    loaded.renderers = files.map(f => f.replace(".tsx", ""));
    log.info({ name, renderers: loaded.renderers }, "PluginManager: discovered renderers");
  }
}
```

Since loadPlugin now uses `await import()`, make it async:

```typescript
private async loadPlugin(name: string, ps: PluginSettings): Promise<void> {
```

And update all callers to `await this.loadPlugin(...)`.

- [ ] **Step 3: Update start() method to await loadPlugin**

```typescript
async start(bus: EventBus): Promise<void> {
  this.bus = bus;
  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });

  const settings = loadSettings();
  for (const [name, ps] of Object.entries(settings.plugins ?? {})) {
    if (ps.enabled) await this.loadPlugin(name, ps);
  }

  this.registerTools();
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Add unloading on disable**

Update the `plugin_disable` handler to stop pieces:

```typescript
handler: async (input) => {
  const name = String(input.name);
  const settings = loadSettings();
  if (!settings.plugins?.[name]) return { ok: false, error: `Plugin not found: ${name}` };

  // Stop plugin pieces
  const loaded = this.plugins.get(name);
  if (loaded && this.pieceManager) {
    for (const pieceId of loaded.pieces) {
      await this.pieceManager.unregisterDynamic(pieceId);
    }
  }

  settings.plugins[name].enabled = false;
  saveSettings(settings);
  this.plugins.delete(name);
  this.updateHud();
  return { ok: true };
},
```

- [ ] **Step 5: Update install() to await**

Change `this.loadPlugin(name, ...)` to `await this.loadPlugin(name, ...)` inside `install()`. Make `install()` async.

- [ ] **Step 6: Update LoadedPlugin default in loadPlugin**

```typescript
const loaded: LoadedPlugin = { name, manifest, settings: ps, tools: [], prompts: [], pieces: [], renderers: [] };
```

- [ ] **Step 7: Update systemContext to include pieces info**

```typescript
systemContext(): string {
  if (this.plugins.size === 0) return "";
  const list = [...this.plugins.values()]
    .map(p => `${p.name}: ${p.manifest.description} (${p.tools.length} tools, ${p.pieces.length} pieces)`)
    .join("\n");
  return `## Plugins\n${list}\nTools: plugin_install, plugin_list, plugin_update, plugin_enable, plugin_disable, plugin_remove`;
}
```

- [ ] **Step 8: Update main.ts — pass PieceManager to PluginManager**

After PieceManager creation (line ~66), add:

```typescript
pluginManager.setPieceManager(pieceManager);
```

The full wiring section becomes:

```typescript
const pluginManager = new PluginManager(toolRegistry);
pieces.push(pluginManager);

const hudState = new HudState(bus);
const pieceManager = new PieceManager(pieces, bus, toolRegistry);
pluginManager.setPieceManager(pieceManager);

await pieceManager.startAll();
```

- [ ] **Step 9: Verify everything compiles**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add app/src/core/plugin-manager.ts app/src/main.ts
git commit -m "feat: PluginManager loads pieces and discovers renderers"
```

---

## Task 7: Add lazy renderer loading to HUD frontend

**Files:**
- Modify: `app/ui/src/components/renderers/index.ts`
- Modify: `app/ui/src/components/HudRenderer.tsx`

- [ ] **Step 1: Make renderer registry dynamic**

Update `app/ui/src/components/renderers/index.ts`:

```typescript
import type { ReactNode } from 'react'
import type { HudComponentState } from '../../types/hud'
import { JarvisCoreRenderer } from './JarvisCoreRenderer'
import { GrpcRenderer } from './GrpcRenderer'
import { TokenCounterRenderer } from './TokenCounterRenderer'
import { ToolExecutorRenderer } from './ToolExecutorRenderer'
import { McpManagerRenderer } from './McpManagerRenderer'
import { ChatInputRenderer } from './ChatInputRenderer'
import { ChatOutputRenderer } from './ChatOutputRenderer'

type Renderer = (props: { state: HudComponentState }) => ReactNode

export const renderers: Record<string, Renderer> = {
  "jarvis-core": JarvisCoreRenderer,
  "chat-input": ChatInputRenderer,
  "chat-output": ChatOutputRenderer,
  "grpc": GrpcRenderer,
  "token-counter": TokenCounterRenderer,
  "tool-executor": ToolExecutorRenderer,
  "mcp-manager": McpManagerRenderer,
}
```

No change to the static renderers — the dynamic loading happens in HudRenderer.

- [ ] **Step 2: Update HudRenderer for plugin renderers**

Update `app/ui/src/components/HudRenderer.tsx`. Add lazy loading:

```typescript
import { useState, useCallback, lazy, Suspense, useMemo } from 'react'
import type { HudState } from '../types/hud'
import { DraggablePanel } from './DraggablePanel'
import { renderers } from './renderers/index'
import { ReactorCore } from './ReactorCore'
import { ActorPoolRenderer } from './renderers/ActorPoolRenderer'
import { ActorChat } from './panels/ActorChat'

// Cache for lazily loaded plugin renderers
const pluginRendererCache: Record<string, React.LazyExoticComponent<any>> = {}

function getPluginRenderer(plugin: string, file: string) {
  const key = `${plugin}/${file}`
  if (!pluginRendererCache[key]) {
    pluginRendererCache[key] = lazy(() =>
      import(/* @vite-ignore */ `/plugins/${plugin}/renderers/${file}.js`)
    )
  }
  return pluginRendererCache[key]
}

function GenericRenderer({ state }: { state: any }) {
  return (
    <div style={{ padding: '8px', fontSize: '10px', color: '#8af', fontFamily: 'monospace' }}>
      <div style={{ marginBottom: '4px', opacity: 0.7 }}>STATUS: {state.status}</div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#6af' }}>
        {JSON.stringify(state.data, null, 2)}
      </pre>
    </div>
  )
}
```

Then update the panel rendering section (the `otherComps.filter(...).map(...)` block):

```typescript
{otherComps.filter(c => !hiddenPanels.has(c.id)).map(comp => {
  // 1. Try built-in renderer
  let Renderer = renderers[comp.id]

  // 2. Try plugin renderer
  if (!Renderer && comp.renderer) {
    const PluginRenderer = getPluginRenderer(comp.renderer.plugin, comp.renderer.file)
    return (
      <DraggablePanel
        key={comp.id}
        id={comp.name.toUpperCase()}
        pieceId={comp.id}
        defaultX={comp.position.x}
        defaultY={comp.position.y}
        defaultWidth={comp.size.width}
        defaultHeight={comp.size.height}
        minWidth={100}
        minHeight={60}
        onClose={() => hidePanel(comp.id)}
      >
        <Suspense fallback={<GenericRenderer state={comp} />}>
          <PluginRenderer state={comp} />
        </Suspense>
      </DraggablePanel>
    )
  }

  // 3. No renderer — skip (or show generic for plugin pieces)
  if (!Renderer) {
    if (comp.data && Object.keys(comp.data).length > 0) {
      return (
        <DraggablePanel
          key={comp.id}
          id={comp.name.toUpperCase()}
          pieceId={comp.id}
          defaultX={comp.position.x}
          defaultY={comp.position.y}
          defaultWidth={comp.size.width}
          defaultHeight={comp.size.height}
          minWidth={100}
          minHeight={60}
          onClose={() => hidePanel(comp.id)}
        >
          <GenericRenderer state={comp} />
        </DraggablePanel>
      )
    }
    return null
  }

  return (
    <DraggablePanel
      key={comp.id}
      id={comp.name.toUpperCase()}
      pieceId={comp.id}
      defaultX={comp.position.x}
      defaultY={comp.position.y}
      defaultWidth={comp.size.width}
      defaultHeight={comp.size.height}
      minWidth={100}
      minHeight={60}
      onClose={() => hidePanel(comp.id)}
    >
      <Renderer state={comp} />
    </DraggablePanel>
  )
})}
```

- [ ] **Step 3: Update HUD types to include renderer**

In `app/ui/src/types/hud.ts`, add renderer to HudComponentState:

```typescript
renderer?: { plugin: string; file: string };
```

- [ ] **Step 4: Configure Vite for external React in plugin renderers**

Plugin renderers import React as external. The esbuild compilation marks it external, but the browser needs to resolve it. Add to `app/ui/vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Expose React as a global for plugin renderers
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
      },
    },
  },
})
```

Also add to `app/ui/index.html` an import map for plugin module resolution:

```html
<script type="importmap">
{
  "imports": {
    "react": "/node_modules/react/index.js",
    "react-dom": "/node_modules/react-dom/index.js",
    "react/jsx-runtime": "/node_modules/react/jsx-runtime.js"
  }
}
</script>
```

Note: This may need adjustment based on how Vite serves modules in dev vs prod. The import map approach works in Electron since we control the runtime. If it doesn't resolve cleanly, an alternative is to have the esbuild step inline React references using `define` to point to `window.React`.

- [ ] **Step 5: Rebuild UI**

Run: `cd app/ui && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/ui/
git commit -m "feat: lazy-load plugin renderers in HUD"
```

---

## Task 8: Create voice plugin pieces and renderer

**Files:**
- Modify: `~/dev/personal/jarvis-plugin-voice/plugin.json`
- Create: `~/dev/personal/jarvis-plugin-voice/package.json`
- Create: `~/dev/personal/jarvis-plugin-voice/pieces/index.ts`
- Create: `~/dev/personal/jarvis-plugin-voice/pieces/voice-piece.ts`
- Create: `~/dev/personal/jarvis-plugin-voice/renderers/VoiceRenderer.tsx`

- [ ] **Step 1: Update plugin.json**

```json
{
  "name": "jarvis-plugin-voice",
  "version": "2.0.0",
  "description": "Voice I/O for JARVIS — TTS (Kokoro) + STT (Whisper) + Voice HUD",
  "author": "giovanibarili",
  "entry": "pieces/index.ts",
  "capabilities": {
    "tools": true,
    "pieces": true,
    "renderers": true,
    "prompts": true
  }
}
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "jarvis-plugin-voice",
  "version": "2.0.0",
  "type": "module",
  "peerDependencies": {
    "@jarvis/core": "^1.0.0"
  }
}
```

- [ ] **Step 3: Create pieces/index.ts**

```typescript
import type { PluginContext, Piece } from "@jarvis/core";
import { VoicePiece } from "./voice-piece.js";

export function createPieces(ctx: PluginContext): Piece[] {
  return [new VoicePiece(ctx)];
}
```

- [ ] **Step 4: Create pieces/voice-piece.ts**

This is the VoicePiece adapted from the deleted `src/output/voice-piece.ts`. Key changes: imports from `@jarvis/core` instead of relative paths, receives PluginContext instead of ToolRegistry directly, tools already exist as JSON configs (no need to re-register them programmatically — PluginManager handles that). The piece focuses on TTS lifecycle, audio streaming, and HUD state.

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  Piece, EventBus, PluginContext,
  HudPieceAddEvent, HudPieceUpdateEvent, HudPieceRemoveEvent,
  InputPromptEvent, StreamCompleteEvent,
} from "@jarvis/core";
import { HUD_TOPICS } from "@jarvis/core";

interface VoiceConfig {
  ttsUrl: string;
  model: string;
  voice: string;
  enabled: boolean;
  port: number;
  sttLanguage: string;
  kokoroDir: string;
  kokoroAutoStart: boolean;
}

export class VoicePiece implements Piece {
  readonly id = "voice";
  readonly name = "Voice I/O";

  private bus!: EventBus;
  private config: VoiceConfig;
  private speaking = false;
  private latestAudio: Buffer | null = null;
  private latestAudioId = "";
  private totalSpoken = 0;
  private server?: ReturnType<typeof createServer>;
  private ttsHealthy: boolean | null = null;
  private healthInterval?: ReturnType<typeof setInterval>;
  private bootRetries = 0;
  private bootDone = false;
  private kokoroProcess: ChildProcess | null = null;
  private kokoroStartAttempted = false;
  private audioStreamClients = new Set<ServerResponse>();

  constructor(ctx: PluginContext) {
    const saved = ctx.config as Record<string, unknown>;
    this.config = {
      ttsUrl: (saved.ttsUrl as string) ?? process.env.JARVIS_TTS_URL ?? "http://localhost:8880",
      model: (saved.model as string) ?? "kokoro",
      voice: (saved.voice as string) ?? process.env.JARVIS_TTS_VOICE ?? "bm_george",
      enabled: process.env.JARVIS_TTS_ENABLED !== "false",
      port: Number(process.env.JARVIS_VOICE_PORT ?? "50054"),
      sttLanguage: (saved.sttLanguage as string) ?? process.env.JARVIS_STT_LANG ?? "auto",
      kokoroDir: process.env.JARVIS_KOKORO_DIR ?? `${process.env.HOME}/dev/personal/kokoro-local`,
      kokoroAutoStart: process.env.JARVIS_KOKORO_AUTOSTART !== "false",
    };
  }

  systemContext(): string {
    return `## Voice I/O Plugin
TTS: Kokoro engine at ${this.config.ttsUrl}. Voice: ${this.config.voice}. Enabled: ${this.config.enabled}. Healthy: ${this.ttsHealthy}.
STT: Whisper on port 50055. Language: ${this.config.sttLanguage}.
Tools: voice_set, voice_list, stt_language (loaded from plugin tools/).
Voice categories: af_* (American Female), am_* (American Male), bf_* (British Female), bm_* (British Male), pm_* (Portuguese Male), pf_* (Portuguese Female).`;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.bus.subscribe<StreamCompleteEvent>("core.main.stream.complete", (msg) => this.handleComplete(msg));

    // Register HUD piece with renderer metadata
    this.bus.publish<HudPieceAddEvent>(HUD_TOPICS.ADD, {
      sessionId: "system",
      componentId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: this.config.enabled ? "running" : "stopped",
        data: this.getData(),
        position: { x: 10, y: 400 },
        size: { width: 220, height: 180 },
        renderer: { plugin: "jarvis-plugin-voice", file: "VoiceRenderer" },
      },
    });

    // Audio stream server
    this.server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (req.url?.startsWith("/stream.mp3")) { this.serveAudioStream(req, res); }
      else if (req.url?.startsWith("/latest.mp3")) { this.serveLatest(res); }
      else { res.writeHead(404); res.end(); }
    });
    this.server.listen(this.config.port);

    // TTS health check with boot phase
    const bootCheck = setInterval(async () => {
      await this.checkTtsHealth();
      this.bootRetries++;
      if (this.bootRetries === 1 && !this.ttsHealthy) this.startKokoro();
      if (this.ttsHealthy || this.bootRetries >= 10) {
        clearInterval(bootCheck);
        this.bootDone = true;
        if (!this.ttsHealthy) this.notifyCore(false);
        this.healthInterval = setInterval(() => this.checkTtsHealth(), 10000);
      }
    }, 5000);
  }

  async stop(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval);
    this.kokoroProcess?.kill();
    this.kokoroProcess = null;
    this.server?.close();
    this.bus.publish<HudPieceRemoveEvent>(HUD_TOPICS.REMOVE, {
      sessionId: "system",
      componentId: this.id,
      pieceId: this.id,
    });
  }

  private async handleComplete(msg: StreamCompleteEvent): Promise<void> {
    if (!this.config.enabled || !this.ttsHealthy) return;
    const text = this.stripMarkdown(msg.fullText.trim());
    if (!text) return;

    this.speaking = true;
    this.latestAudioId = crypto.randomUUID();
    this.latestAudio = null;
    this.updateHud();

    try {
      const response = await fetch(`${this.config.ttsUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          input: text.slice(0, 4096),
          voice: this.config.voice,
          stream: true,
          response_format: "mp3",
        }),
      });
      if (!response.ok) throw new Error(`TTS: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No body");

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          for (const client of this.audioStreamClients) {
            try { client.write(Buffer.from(value)); } catch {}
          }
        }
      }

      this.latestAudio = Buffer.concat(chunks.map(c => Buffer.from(c)));
      this.totalSpoken++;
    } catch {} finally {
      this.speaking = false;
      for (const client of this.audioStreamClients) { try { client.end(); } catch {} }
      this.audioStreamClients.clear();
      this.updateHud();
    }
  }

  private async checkTtsHealth(): Promise<void> {
    let healthy = false;
    try { healthy = (await fetch(`${this.config.ttsUrl}/health`)).ok; } catch {}
    const was = this.ttsHealthy;
    this.ttsHealthy = healthy;
    if (this.bootDone && healthy !== was) {
      if (!healthy && !this.kokoroProcess) this.startKokoro();
      this.notifyCore(healthy);
    }
  }

  private startKokoro(): void {
    if (this.kokoroStartAttempted || !this.config.kokoroAutoStart) return;
    this.kokoroStartAttempted = true;
    const dir = this.config.kokoroDir;
    const py = `${dir}/venv/bin/python3`;
    if (!existsSync(py)) return;

    this.kokoroProcess = spawn(py, ["-m", "uvicorn", "api.src.main:app", "--host", "127.0.0.1", "--port", "8880"], {
      cwd: dir,
      env: {
        ...process.env,
        PHONEMIZER_ESPEAK_LIBRARY: "/opt/homebrew/lib/libespeak-ng.dylib",
        USE_GPU: "false",
        MODEL_DIR: `${dir}/api/src/models`,
        VOICES_DIR: `${dir}/api/src/voices/v1_0`,
        PROJECT_ROOT: dir,
        VIRTUAL_ENV: `${dir}/venv`,
        PATH: `${dir}/venv/bin:${process.env.PATH}`,
      },
      stdio: "ignore",
    });
    this.kokoroProcess.on("exit", () => { this.kokoroProcess = null; this.kokoroStartAttempted = false; });
  }

  private notifyCore(healthy: boolean): void {
    const text = healthy
      ? `[SYSTEM] Voice plugin: TTS (Kokoro) online. Voice: ${this.config.voice}.`
      : `[SYSTEM] Voice plugin: TTS (Kokoro) offline at ${this.config.ttsUrl}.`;
    this.bus.publish<InputPromptEvent>("input.prompt", {
      sessionId: "main", componentId: this.id, text,
    });
  }

  private serveAudioStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Transfer-Encoding": "chunked", "Cache-Control": "no-cache" });
    this.audioStreamClients.add(res);
    req.on("close", () => this.audioStreamClients.delete(res));
  }

  private serveLatest(res: ServerResponse): void {
    if (!this.latestAudio) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": this.latestAudio.length });
    res.end(this.latestAudio);
  }

  private stripMarkdown(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[#*_~|>-]/g, "")
      .replace(/\|[^\n]+\|/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private getData(): Record<string, unknown> {
    return {
      voice: this.config.voice,
      model: this.config.model,
      enabled: this.config.enabled,
      speaking: this.speaking,
      totalSpoken: this.totalSpoken,
      ttsHealthy: this.ttsHealthy,
      sttLanguage: this.config.sttLanguage,
    };
  }

  private updateHud(): void {
    this.bus.publish<HudPieceUpdateEvent>(HUD_TOPICS.UPDATE, {
      sessionId: "system",
      componentId: this.id,
      pieceId: this.id,
      data: this.getData(),
      status: this.speaking ? "processing" : this.config.enabled ? "running" : "stopped",
    });
  }
}
```

- [ ] **Step 5: Create renderers/VoiceRenderer.tsx**

```tsx
import type { ReactNode } from 'react'

interface VoiceData {
  voice?: string;
  enabled?: boolean;
  speaking?: boolean;
  totalSpoken?: number;
  ttsHealthy?: boolean | null;
  sttLanguage?: string;
}

export default function VoiceRenderer({ state }: { state: { status: string; data: VoiceData } }): ReactNode {
  const d = state.data;
  const healthColor = d.ttsHealthy === true ? '#4f4' : d.ttsHealthy === false ? '#f44' : '#888';
  const statusColor = d.speaking ? '#fa4' : d.enabled ? '#4af' : '#666';

  return (
    <div style={{ padding: '10px', fontFamily: 'monospace', fontSize: '11px', color: '#ccc' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <div style={{
          width: '10px', height: '10px', borderRadius: '50%',
          backgroundColor: statusColor,
          boxShadow: `0 0 6px ${statusColor}`,
        }} />
        <span style={{ color: statusColor, letterSpacing: '2px', fontSize: '10px' }}>
          {d.speaking ? 'SPEAKING' : d.enabled ? 'READY' : 'DISABLED'}
        </span>
      </div>

      <div style={{ marginBottom: '4px' }}>
        <span style={{ color: '#888' }}>VOICE: </span>
        <span style={{ color: '#8af' }}>{d.voice ?? 'unknown'}</span>
      </div>

      <div style={{ marginBottom: '4px' }}>
        <span style={{ color: '#888' }}>TTS: </span>
        <span style={{ color: healthColor }}>
          {d.ttsHealthy === true ? 'ONLINE' : d.ttsHealthy === false ? 'OFFLINE' : 'CHECKING'}
        </span>
      </div>

      <div style={{ marginBottom: '4px' }}>
        <span style={{ color: '#888' }}>STT LANG: </span>
        <span style={{ color: '#8af' }}>{d.sttLanguage ?? 'auto'}</span>
      </div>

      <div>
        <span style={{ color: '#888' }}>SPOKEN: </span>
        <span style={{ color: '#8af' }}>{d.totalSpoken ?? 0}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Commit voice plugin**

```bash
cd ~/dev/personal/jarvis-plugin-voice
git add -A
git commit -m "feat: add VoicePiece and VoiceRenderer for plugin phase 2"
git push
```

---

## Task 9: Integration test — install voice plugin and validate

- [ ] **Step 1: Start JARVIS**

```bash
cd app && npx tsx src/main.ts
```

Expected: "JARVIS online", all core pieces start.

- [ ] **Step 2: Install voice plugin via tool**

Use gRPC or chat to send: "Install the voice plugin from github.com/giovanibarili/jarvis-plugin-voice"

Expected: JARVIS calls `plugin_install`, clones repo, loads tools + prompts + pieces. VoicePiece starts, publishes HUD event.

- [ ] **Step 3: Verify piece registered**

Send: "List all pieces"

Expected: `piece_list` shows `voice` piece as enabled/running alongside core pieces.

- [ ] **Step 4: Verify HUD shows VoiceRenderer**

Open `http://localhost:50052` in browser.

Expected: Voice panel appears with status (READY/DISABLED), voice name, TTS health, STT language, spoken count. Loaded via lazy import from `/plugins/jarvis-plugin-voice/renderers/VoiceRenderer.js`.

- [ ] **Step 5: Verify system context includes voice**

Send: "What plugins and capabilities do you have?"

Expected: JARVIS mentions voice plugin with TTS/STT info (from VoicePiece.systemContext()).

- [ ] **Step 6: Verify disable/enable cycle**

Send: "Disable the voice plugin"

Expected: VoicePiece stops, renderer removed from HUD. `plugin_list` shows disabled.

Send: "Enable the voice plugin"

Expected: VoicePiece restarts, renderer re-appears.

- [ ] **Step 7: Verify existing voice tools still work**

Send: "List available voices"

Expected: `voice_list` tool returns voices from Kokoro (if running) or error if offline.

- [ ] **Step 8: Commit any integration fixes**

```bash
git add -A
git commit -m "fix: integration adjustments for plugin phase 2"
```

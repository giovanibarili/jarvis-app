# Actor Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract ActorPiece from core into a standalone plugin with 3 specialized pieces, extended PluginContext (sessionFactory + route registration), and AI interfaces in @jarvis/core.

**Architecture:** Plugin `jarvis-plugin-actors` provides ActorPoolPiece (lifecycle/tools/HUD), ActorRunnerPiece (task execution/AI sessions), and ActorChatPiece (HTTP routes/SSE). Communication via EventBus with new topics `actor.dispatch` and `actor.dispatch.result`. AI session interfaces extracted to @jarvis/core. HTTP routes registered on main server via PluginContext.

**Tech Stack:** TypeScript, tsx (on-the-fly), @jarvis/core, EventBus pub/sub

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `packages/core/src/ai.ts` | AISession, AISessionFactory, AIStreamEvent interfaces |
| Plugin: `pieces/index.ts` | createPieces(ctx) factory |
| Plugin: `pieces/types.ts` | Actor, ActorRole, dispatch event types |
| Plugin: `pieces/actor-pool.ts` | Pool lifecycle, tools, HUD |
| Plugin: `pieces/actor-runner.ts` | Task execution, AI sessions, stream |
| Plugin: `pieces/actor-chat.ts` | HTTP routes, SSE, history |
| Plugin: `renderers/ActorPoolRenderer.tsx` | Actor list with status |
| Plugin: `plugin.json` | Manifest |
| Plugin: `package.json` | peerDependency on @jarvis/core |

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/plugin.ts` | Add sessionFactory, registerRoute to PluginContext |
| `packages/core/src/index.ts` | Re-export ai.ts |
| `app/src/ai/types.ts` | Keep as-is (app re-exports, core has own copy) |
| `app/src/ai/anthropic/factory.ts` | Add createWithPrompt to AISessionFactory interface |
| `app/src/server.ts` | Add registerRoute() method, route plugin requests |
| `app/src/core/plugin-manager.ts` | Pass sessionFactory + registerRoute in PluginContext |
| `app/src/main.ts` | Remove ActorPiece, pass factory+server to PluginManager |
| `app/ui/src/components/panels/ActorChat.tsx` | Update port from 50056 to 50052, update URL paths |

### Deleted files

| File | Reason |
|------|--------|
| `app/src/core/actor-piece.ts` | Replaced by plugin |
| `app/actor-system.md` | Moves to plugin |

---

## Task 1: Add AI interfaces to @jarvis/core

**Files:**
- Create: `packages/core/src/ai.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/plugin.ts`

- [ ] **Step 1: Create packages/core/src/ai.ts**

```typescript
// packages/core/src/ai.ts
import type { ToolCall, ToolResult } from "./tools.js";

export interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string): AsyncGenerator<AIStreamEvent, void>;
  addToolResults(toolCalls: ToolCall[], results: ToolResult[]): void;
  continueAndStream(): AsyncGenerator<AIStreamEvent, void>;
  close(): void;
}

export interface AISessionFactory {
  create(options?: { label?: string }): AISession;
  createWithPrompt(prompt: string, options?: { label?: string }): AISession;
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
}
```

- [ ] **Step 2: Update packages/core/src/index.ts — add ai export**

```typescript
export * from "./types.js";
export * from "./bus.js";
export * from "./piece.js";
export * from "./tools.js";
export * from "./plugin.js";
export * from "./ai.js";
```

- [ ] **Step 3: Update packages/core/src/plugin.ts — extend PluginContext**

```typescript
import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { ToolRegistry } from "./tools.js";
import type { AISessionFactory } from "./ai.js";
import type { IncomingMessage, ServerResponse } from "node:http";

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

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface PluginContext {
  bus: EventBus;
  toolRegistry: ToolRegistry;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: AISessionFactory;
  registerRoute: (method: string, path: string, handler: RouteHandler) => void;
}

export interface JarvisPlugin {
  createPieces?(ctx: PluginContext): Piece[];
}
```

- [ ] **Step 4: Verify**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/
git commit -m "feat: add AI interfaces and extended PluginContext to @jarvis/core"
```

---

## Task 2: Add route registration to HttpServer

**Files:**
- Modify: `app/src/server.ts`

- [ ] **Step 1: Add route registry to HttpServer**

Add field and method to the HttpServer class. Add after `private rendererCache` (line 28):

```typescript
private pluginRoutes = new Map<string, RouteHandler>();

registerRoute(method: string, path: string, handler: RouteHandler): void {
  const key = `${method.toUpperCase()} ${path}`;
  this.pluginRoutes.set(key, handler);
  log.info({ method, path }, "HttpServer: plugin route registered");
}
```

Add the `RouteHandler` type at the top (after the imports):

```typescript
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;
```

- [ ] **Step 2: Add plugin route dispatch in handle()**

Add this block after the `/logs` route (before the plugin renderer section, around line 103):

```typescript
// Plugin-registered routes
const routeKey = `${req.method} ${req.url}`;
const pluginHandler = this.pluginRoutes.get(routeKey);
if (pluginHandler) {
  pluginHandler(req, res);
  return;
}

// Plugin routes with path params (match prefix)
for (const [key, handler] of this.pluginRoutes) {
  const [method, pattern] = key.split(" ", 2);
  if (req.method === method && req.url?.startsWith(pattern.replace(/\/:[^/]+/g, ""))) {
    // Check if it's a parameterized match
    const patternParts = pattern.split("/");
    const urlParts = req.url.split("?")[0].split("/");
    if (patternParts.length === urlParts.length) {
      let match = true;
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(":")) continue;
        if (patternParts[i] !== urlParts[i]) { match = false; break; }
      }
      if (match) { handler(req, res); return; }
    }
  }
}
```

Actually, this is over-engineered. Plugin routes should register exact paths or use their own URL parsing. Simpler approach — match by prefix:

```typescript
// Plugin-registered routes (exact match or prefix match)
for (const [key, handler] of this.pluginRoutes) {
  const [method, path] = key.split(" ", 2);
  if (req.method === method && req.url?.startsWith(path)) {
    handler(req, res);
    return;
  }
}
```

Wait, this would match too broadly. Let the plugin register with exact method+path, and for dynamic paths (like `/plugins/actors/{name}/stream`), the plugin registers a prefix and parses the URL internally:

```typescript
// Plugin-registered routes
for (const [key, handler] of this.pluginRoutes) {
  const spaceIdx = key.indexOf(" ");
  const method = key.slice(0, spaceIdx);
  const path = key.slice(spaceIdx + 1);
  if (req.method === method && req.url?.startsWith(path)) {
    handler(req, res);
    return;
  }
}
```

Add this block BEFORE the plugin renderer compilation section (before line 104).

- [ ] **Step 3: Verify**

Run: `cd app && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/server.ts
git commit -m "feat: add plugin route registration to HttpServer"
```

---

## Task 3: Pass sessionFactory and registerRoute to PluginManager

**Files:**
- Modify: `app/src/core/plugin-manager.ts`
- Modify: `app/src/main.ts`

- [ ] **Step 1: Add factory and server fields to PluginManager**

Add imports at top:

```typescript
import type { AISessionFactory } from "../ai/types.js";
import type { HttpServer } from "../server.js";
```

Add fields and setter:

```typescript
private factory?: AISessionFactory;
private httpServer?: HttpServer;

setFactory(factory: AISessionFactory): void {
  this.factory = factory;
}

setHttpServer(server: HttpServer): void {
  this.httpServer = server;
}
```

- [ ] **Step 2: Update PluginContext construction in loadPlugin**

Find the PluginContext construction (around line 172). Replace:

```typescript
const ctx: PluginContext = {
  bus: this.bus as unknown as PluginContext["bus"],
  toolRegistry: this.registry,
  config: loadSettings().pieces?.[`plugin:${name}`]?.config ?? {},
  pluginDir,
};
```

With:

```typescript
const ctx: PluginContext = {
  bus: this.bus as unknown as PluginContext["bus"],
  toolRegistry: this.registry,
  config: loadSettings().pieces?.[`plugin:${name}`]?.config ?? {},
  pluginDir,
  sessionFactory: this.factory as unknown as PluginContext["sessionFactory"],
  registerRoute: (method: string, path: string, handler: any) => {
    if (this.httpServer) {
      this.httpServer.registerRoute(method, path, handler);
    }
  },
};
```

- [ ] **Step 3: Update main.ts — remove ActorPiece, pass factory+server**

Replace main.ts content:

```typescript
// src/main.ts
import { EventBus } from "./core/bus.js";
import { SessionManager } from "./core/session-manager.js";
import { JarvisCore } from "./core/jarvis.js";
import { HudState } from "./core/hud-state.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolExecutor } from "./tools/executor.js";
import { ToolLoaderPiece } from "./tools/loader.js";
import { TokenCounter } from "./output/token-counter.js";
import { McpManager } from "./mcp/manager.js";
import { ChatPiece } from "./input/chat-piece.js";
import { GrpcPiece } from "./input/grpc-piece.js";
import { AnthropicSessionFactory } from "./ai/anthropic/factory.js";
import { HttpServer } from "./server.js";
import { PieceManager } from "./core/piece-manager.js";
import { PluginManager } from "./core/plugin-manager.js";
import type { Piece } from "./core/piece.js";
import { log } from "./logger/index.js";
import { launchHud } from "./transport/hud/electron.js";

async function main() {
  const bus = new EventBus();
  const toolRegistry = new ToolRegistry();

  const chatPiece = new ChatPiece();
  const jarvisCore = new JarvisCore();

  const pieces: Piece[] = [
    jarvisCore,
    new ToolExecutor(toolRegistry),
    new ToolLoaderPiece(toolRegistry),
    new McpManager(toolRegistry),
    new GrpcPiece(toolRegistry),
    chatPiece,
  ];

  const factory = new AnthropicSessionFactory(
    () => toolRegistry.getDefinitions(),
    () => pieces.filter(p => p.systemContext).map(p => p.systemContext!()),
  );

  const tokenCounter = new TokenCounter(factory);
  pieces.splice(3, 0, tokenCounter);

  const sessions = new SessionManager(factory);
  jarvisCore.setSessions(sessions);

  // Plugin manager — no more ActorPiece in core
  const pluginManager = new PluginManager(toolRegistry);
  pluginManager.setFactory(factory);
  pieces.push(pluginManager);

  const hudState = new HudState(bus);
  const pieceManager = new PieceManager(pieces, bus, toolRegistry);
  pluginManager.setPieceManager(pieceManager);

  // HTTP server
  const server = new HttpServer(50052, chatPiece, () => hudState.getState());
  pluginManager.setHttpServer(server);

  await pieceManager.startAll();

  console.log("JARVIS starting...");
  console.log(`HUD  ${server.url}\n`);
  launchHud(server.url);
  jarvisCore.ready();
  console.log("JARVIS online\n");

  process.on("SIGINT", async () => {
    log.info("Shutting down...");
    await pieceManager.stopAll();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => { log.fatal({ err }, "Startup failed"); process.exit(1); });
```

Key changes: removed `ActorPiece` import and instantiation, added `pluginManager.setFactory(factory)` and `pluginManager.setHttpServer(server)`. Moved `pieceManager.startAll()` to AFTER server creation so plugins can register routes during startup.

- [ ] **Step 4: Delete actor-piece.ts**

```bash
git rm app/src/core/actor-piece.ts
```

- [ ] **Step 5: Verify**

Run: `cd app && npx tsc --noEmit`
Expected: no errors (ActorPiece was only referenced in main.ts).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove ActorPiece from core, wire factory+server to PluginManager"
```

---

## Task 4: Create actor plugin — types and ActorPoolPiece

**Files:**
- Create: `~/dev/personal/jarvis-plugin-actors/plugin.json`
- Create: `~/dev/personal/jarvis-plugin-actors/package.json`
- Create: `~/dev/personal/jarvis-plugin-actors/pieces/types.ts`
- Create: `~/dev/personal/jarvis-plugin-actors/pieces/actor-pool.ts`

Note: create the repo at `~/dev/personal/jarvis-plugin-actors/` (separate from jarvis-app).

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "jarvis-plugin-actors",
  "version": "1.0.0",
  "description": "Persistent AI actor pool — delegate tasks to autonomous agents with memory",
  "author": "giovanibarili",
  "entry": "pieces/index.ts",
  "capabilities": {
    "pieces": true,
    "renderers": true
  }
}
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "jarvis-plugin-actors",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": {
    "@jarvis/core": "^1.0.0"
  }
}
```

- [ ] **Step 3: Create pieces/types.ts**

```typescript
// Shared types for the actor plugin

export interface ActorRole {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export type ActorStatus = "idle" | "running" | "waiting_tools" | "stopped";

export interface Actor {
  id: string;
  role: ActorRole;
  status: ActorStatus;
  createdAt: number;
  taskCount: number;
  currentTask?: string;
  lastResult?: string;
  replySessionId: string;
  chatHistory: Array<{ role: 'user' | 'actor'; text: string; source?: string }>;
}

// Bus event payloads
export interface ActorDispatchEvent {
  name: string;
  role: string;
  task: string;
  replySessionId: string;
}

export interface ActorDispatchResultEvent {
  name: string;
  result: string;
  replySessionId: string;
}

export const BUILT_IN_ROLES: ActorRole[] = [
  {
    id: "generic",
    name: "Generic Worker",
    description: "General-purpose worker. Can handle any task the core delegates.",
    systemPrompt: "You are a worker agent for JARVIS. Execute tasks given to you autonomously. Use the available tools as needed. Be thorough and report your results clearly. Do not ask questions — make reasonable decisions and proceed.",
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Investigates topics, reads files, searches codebases. Read-only, never modifies files.",
    systemPrompt: "You are a research agent for JARVIS. Your job is to investigate, analyze, and report findings. Read files, search codebases, browse documentation. NEVER modify files — you are read-only. Be thorough and cite sources (file paths, line numbers).",
  },
  {
    id: "coder",
    name: "Coder",
    description: "Writes and edits code. Creates files, implements features, fixes bugs.",
    systemPrompt: "You are a coding agent for JARVIS. Write clean, correct code. Use edit_file for surgical changes, write_file for new files. Run bash to test. Follow existing patterns in the codebase. Commit nothing — just make the changes.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews code for correctness, style, bugs. Read-only analysis.",
    systemPrompt: "You are a code review agent for JARVIS. Analyze the code for bugs, style issues, security problems, and architectural concerns. Be specific — cite file paths and line numbers. Rate severity: critical, important, suggestion. NEVER modify files.",
  },
];

export const MAX_ACTORS = 5;
export const MAX_TOOL_ROUNDS = 15;
export const MAX_CHAT_HISTORY = 500;
```

- [ ] **Step 4: Create pieces/actor-pool.ts**

```typescript
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Actor, ActorRole, ActorDispatchEvent, ActorDispatchResultEvent } from "./types.js";
import { BUILT_IN_ROLES, MAX_ACTORS } from "./types.js";

interface EventBus {
  publish<T>(topic: string, data: any): void;
  subscribe<T>(topic: string, handler: (msg: T) => void | Promise<void>): () => void;
}

interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  systemContext?(): string;
}

interface PluginContext {
  bus: EventBus;
  toolRegistry: any;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: any;
  registerRoute: (method: string, path: string, handler: any) => void;
}

const HUD_TOPICS = {
  ADD: "hud.piece.add",
  UPDATE: "hud.piece.update",
  REMOVE: "hud.piece.remove",
} as const;

export class ActorPoolPiece implements Piece {
  readonly id = "actor-pool";
  readonly name = "Actor Pool";

  private bus!: EventBus;
  private ctx: PluginContext;
  private actors = new Map<string, Actor>();
  private roles: ActorRole[];
  private started = false;
  private unsubDispatchResult?: () => void;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.roles = [...BUILT_IN_ROLES];
  }

  systemContext(): string {
    const actorList = [...this.actors.values()]
      .map(a => `${a.id} (${a.role.id}): ${a.status}, ${a.taskCount} tasks done`)
      .join('; ');
    const roleList = this.roles.map(r => `${r.id}: ${r.description}`).join('\n');
    return `## Actor Pool
Delegate tasks to persistent AI actors. Each actor has its own session with memory.
Max actors: ${MAX_ACTORS}. Active: ${actorList || 'none'}.

Available roles:
${roleList}

Tools: actor_dispatch, actor_list, actor_kill, bus_publish`;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    // Listen for dispatch results from ActorRunnerPiece
    this.unsubDispatchResult = this.bus.subscribe("actor.dispatch.result", (msg: any) => {
      this.handleDispatchResult(msg);
    });

    this.registerTools();

    this.bus.publish(HUD_TOPICS.ADD, {
      sessionId: "system",
      componentId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: "running",
        data: this.getData(),
        position: { x: 1680, y: 350 },
        size: { width: 240, height: 120 },
      },
    });
  }

  async stop(): Promise<void> {
    this.unsubDispatchResult?.();
    this.actors.clear();
    this.bus.publish(HUD_TOPICS.REMOVE, {
      sessionId: "system",
      componentId: this.id,
      pieceId: this.id,
    });
  }

  getActors(): Map<string, Actor> {
    return this.actors;
  }

  getOrCreateActor(name: string, roleId: string, replySessionId: string): { actor?: Actor; error?: string } {
    let actor = this.actors.get(name);
    if (actor) {
      if (actor.status === "running" || actor.status === "waiting_tools") {
        return { error: `Actor '${name}' is busy (${actor.status}). Wait or dispatch to a different actor.` };
      }
      actor.replySessionId = replySessionId;
      return { actor };
    }

    const role = this.roles.find(r => r.id === roleId);
    if (!role) return { error: `Unknown role: ${roleId}. Available: ${this.roles.map(r => r.id).join(', ')}` };
    if (this.actors.size >= MAX_ACTORS) {
      return { error: `Pool full (${this.actors.size}/${MAX_ACTORS}). Kill an idle actor first.` };
    }

    actor = {
      id: name,
      role,
      status: "idle",
      createdAt: Date.now(),
      taskCount: 0,
      replySessionId,
      chatHistory: [],
    };
    this.actors.set(name, actor);
    return { actor };
  }

  private handleDispatchResult(msg: any): void {
    const { name, result, replySessionId } = msg as ActorDispatchResultEvent;
    const actor = this.actors.get(name);
    if (actor) {
      actor.status = "idle";
      actor.lastResult = result;
      actor.currentTask = undefined;
    }

    // Notify originating session
    this.bus.publish("input.prompt", {
      sessionId: replySessionId,
      componentId: name,
      text: result,
    });

    this.updateHud();
  }

  private registerTools(): void {
    this.ctx.toolRegistry.register({
      name: "actor_dispatch",
      description: "Send a task to a named actor. If the actor exists, reuses its session (keeps memory). If new, creates one. The actor runs autonomously and reports back when done.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Actor name (e.g. 'alice', 'bob'). Same name = same session." },
          role: { type: "string", description: "Role for new actors: generic, researcher, coder, reviewer." },
          task: { type: "string", description: "The task description" },
        },
        required: ["name", "role", "task"],
      },
      handler: async (input: any) => {
        const sessionId = input.__sessionId ? String(input.__sessionId) : "main";
        const name = String(input.name);
        const roleId = String(input.role);
        const task = String(input.task);

        const { actor, error } = this.getOrCreateActor(name, roleId, sessionId);
        if (error || !actor) return { ok: false, error };

        actor.currentTask = task;
        actor.chatHistory.push({ role: 'user', text: task, source: 'jarvis' });
        actor.status = "running";
        actor.taskCount++;
        this.updateHud();

        // Publish dispatch event for ActorRunnerPiece
        this.bus.publish("actor.dispatch", {
          sessionId: `actor-${name}`,
          componentId: this.id,
          name,
          role: actor.role,
          task,
          replySessionId: sessionId,
        } as any);

        return { ok: true, actorId: name };
      },
    });

    this.ctx.toolRegistry.register({
      name: "actor_list",
      description: "List all actors in the pool with their status, role, and task count.",
      input_schema: { type: "object", properties: {} },
      handler: async () => ({
        maxActors: MAX_ACTORS,
        actors: [...this.actors.values()].map(a => ({
          id: a.id, role: a.role.id, status: a.status, taskCount: a.taskCount,
          currentTask: a.currentTask?.slice(0, 100),
          lastResultPreview: a.lastResult?.slice(0, 200),
          uptime: Math.round((Date.now() - a.createdAt) / 1000) + "s",
        })),
        roles: this.roles.map(r => ({ id: r.id, name: r.name, description: r.description })),
      }),
    });

    this.ctx.toolRegistry.register({
      name: "actor_kill",
      description: "Kill an actor and destroy its session. The actor loses all conversation history.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Actor name to kill" } },
        required: ["name"],
      },
      handler: async (input: any) => {
        const name = String(input.name);
        const actor = this.actors.get(name);
        if (!actor) return { ok: false, error: `Actor not found: ${name}` };
        actor.status = "stopped";
        this.actors.delete(name);
        // Notify runner to close session
        this.bus.publish("actor.kill", { sessionId: "system", componentId: this.id, name });
        this.updateHud();
        return { ok: true };
      },
    });

    this.ctx.toolRegistry.register({
      name: "bus_publish",
      description: "Publish a message to the EventBus. Use to send messages to specific sessions.",
      input_schema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Bus topic (e.g. 'input.prompt')" },
          session_id: { type: "string", description: "Target session ID" },
          text: { type: "string", description: "Message text" },
        },
        required: ["topic", "session_id", "text"],
      },
      handler: async (input: any) => {
        const caller = input.__sessionId ? String(input.__sessionId) : "unknown";
        const source = caller.startsWith("actor-") ? caller.replace("actor-", "") : "jarvis";
        this.bus.publish(String(input.topic), {
          sessionId: String(input.session_id),
          componentId: source,
          text: String(input.text),
        });
        return { ok: true };
      },
    });
  }

  private getData(): Record<string, unknown> {
    const actors = [...this.actors.values()];
    return {
      maxActors: MAX_ACTORS,
      total: actors.length,
      active: actors.filter(a => a.status === "running" || a.status === "waiting_tools").length,
      idle: actors.filter(a => a.status === "idle").length,
      actors: actors.map(a => ({ id: a.id, role: a.role.id, status: a.status, tasks: a.taskCount })),
    };
  }

  private updateHud(): void {
    this.bus.publish(HUD_TOPICS.UPDATE, {
      sessionId: "system",
      componentId: this.id,
      pieceId: this.id,
      data: this.getData(),
      status: [...this.actors.values()].some(a => a.status === "running") ? "processing" : "running",
    });
  }
}
```

- [ ] **Step 5: Commit**

```bash
cd ~/dev/personal/jarvis-plugin-actors
git init
git add plugin.json package.json pieces/types.ts pieces/actor-pool.ts
git commit -m "feat: actor plugin — types and ActorPoolPiece"
```

---

## Task 5: Create ActorRunnerPiece

**Files:**
- Create: `~/dev/personal/jarvis-plugin-actors/pieces/actor-runner.ts`

- [ ] **Step 1: Create pieces/actor-runner.ts**

```typescript
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ActorRole } from "./types.js";
import { MAX_TOOL_ROUNDS, MAX_CHAT_HISTORY } from "./types.js";

interface EventBus {
  publish<T>(topic: string, data: any): void;
  subscribe<T>(topic: string, handler: (msg: T) => void | Promise<void>): () => void;
}

interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}

interface PluginContext {
  bus: EventBus;
  toolRegistry: any;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: any;
}

interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string): AsyncGenerator<any, void>;
  addToolResults(toolCalls: any[], results: any[]): void;
  continueAndStream(): AsyncGenerator<any, void>;
  close(): void;
}

interface ActorSession {
  session: AISession;
  stopped: boolean;
}

export class ActorRunnerPiece implements Piece {
  readonly id = "actor-runner";
  readonly name = "Actor Runner";

  private bus!: EventBus;
  private ctx: PluginContext;
  private sessions = new Map<string, ActorSession>();
  private actorSystemPrompt: string;
  private started = false;
  private unsubDispatch?: () => void;
  private unsubKill?: () => void;
  private unsubDirectMsg?: () => void;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.actorSystemPrompt = this.loadActorSystemPrompt();
  }

  private loadActorSystemPrompt(): string {
    const path = join(this.ctx.pluginDir, "actor-system.md");
    if (existsSync(path)) return readFileSync(path, "utf-8");
    return "You are an autonomous worker agent. Execute tasks using available tools. Report results clearly.";
  }

  private buildActorPrompt(role: ActorRole): string {
    return `${this.actorSystemPrompt}\n\n---\n\n## Your Role: ${role.name}\n\n${role.systemPrompt}`;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    this.unsubDispatch = this.bus.subscribe("actor.dispatch", (msg: any) => {
      this.handleDispatch(msg);
    });

    this.unsubKill = this.bus.subscribe("actor.kill", (msg: any) => {
      this.killSession(msg.name);
    });

    // Direct messages to actors
    this.unsubDirectMsg = this.bus.subscribe("input.prompt", (msg: any) => {
      if (!msg.sessionId?.startsWith("actor-")) return;
      const name = msg.sessionId.replace("actor-", "");
      const as = this.sessions.get(name);
      if (!as || as.stopped) return;
      if (msg.componentId === "actor-pool" || msg.componentId === name) return;
      this.runTask(name, msg.text, msg.replyTo ?? msg.sessionId);
    });
  }

  async stop(): Promise<void> {
    this.unsubDispatch?.();
    this.unsubKill?.();
    this.unsubDirectMsg?.();
    for (const [, as] of this.sessions) {
      as.stopped = true;
      as.session.close();
    }
    this.sessions.clear();
  }

  private handleDispatch(msg: any): void {
    const { name, role, task, replySessionId } = msg;
    this.getOrCreateSession(name, role);
    this.runTask(name, task, replySessionId);
  }

  private getOrCreateSession(name: string, role: ActorRole): ActorSession {
    let as = this.sessions.get(name);
    if (as && !as.stopped) return as;

    const prompt = this.buildActorPrompt(role);
    const session = this.ctx.sessionFactory.createWithPrompt(prompt, { label: `actor-${name}` });
    as = { session, stopped: false };
    this.sessions.set(name, as);
    return as;
  }

  private async runTask(name: string, task: string, replySessionId: string): Promise<void> {
    const as = this.sessions.get(name);
    if (!as || as.stopped) return;

    const actorSessionId = `actor-${name}`;
    let fullText = "";
    let toolRounds = 0;
    let stream = as.session.sendAndStream(task);

    try {
      while (true) {
        const toolCalls: any[] = [];
        fullText = "";

        for await (const event of stream) {
          if (as.stopped) return;
          switch (event.type) {
            case "text_delta":
              fullText += event.text ?? "";
              this.bus.publish(`core.${actorSessionId}.stream.delta`, {
                sessionId: actorSessionId,
                componentId: "actor-runner",
                text: event.text ?? "",
              });
              break;
            case "tool_use":
              if (event.toolUse) toolCalls.push(event.toolUse);
              break;
            case "error":
              this.bus.publish(`core.${actorSessionId}.error`, {
                sessionId: actorSessionId,
                componentId: "actor-runner",
                error: event.error ?? "Unknown error",
              });
              this.publishResult(name, `Error: ${event.error}`, replySessionId);
              return;
          }
        }

        if (as.stopped) return;

        if (toolCalls.length > 0) {
          toolRounds++;
          if (toolRounds > MAX_TOOL_ROUNDS) {
            fullText += "\n\n[Max tool rounds reached. Stopping.]";
            break;
          }
          const results = await this.ctx.toolRegistry.execute(toolCalls);
          as.session.addToolResults(toolCalls, results);
          stream = as.session.continueAndStream();
          continue;
        }

        break;
      }

      this.bus.publish(`core.${actorSessionId}.stream.complete`, {
        sessionId: actorSessionId,
        componentId: "actor-runner",
        fullText,
        usage: { input_tokens: 0, output_tokens: 0 },
      });

      this.publishResult(name, fullText, replySessionId);
    } catch (err) {
      this.publishResult(name, `Crashed: ${err}`, replySessionId);
    }
  }

  private publishResult(name: string, result: string, replySessionId: string): void {
    this.bus.publish("actor.dispatch.result", {
      sessionId: "system",
      componentId: "actor-runner",
      name,
      result,
      replySessionId,
    });
  }

  private killSession(name: string): void {
    const as = this.sessions.get(name);
    if (as) {
      as.stopped = true;
      as.session.close();
      this.sessions.delete(name);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add pieces/actor-runner.ts
git commit -m "feat: ActorRunnerPiece — task execution with AI sessions"
```

---

## Task 6: Create ActorChatPiece and plugin entry

**Files:**
- Create: `~/dev/personal/jarvis-plugin-actors/pieces/actor-chat.ts`
- Create: `~/dev/personal/jarvis-plugin-actors/pieces/index.ts`
- Move: `app/actor-system.md` → plugin

- [ ] **Step 1: Create pieces/actor-chat.ts**

```typescript
import type { Actor } from "./types.js";
import { MAX_CHAT_HISTORY } from "./types.js";

interface EventBus {
  publish<T>(topic: string, data: any): void;
  subscribe<T>(topic: string, handler: (msg: T) => void | Promise<void>): () => void;
}

interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}

interface PluginContext {
  bus: EventBus;
  registerRoute: (method: string, path: string, handler: any) => void;
}

type ServerResponse = import("node:http").ServerResponse;

export class ActorChatPiece implements Piece {
  readonly id = "actor-chat";
  readonly name = "Actor Chat";

  private bus!: EventBus;
  private ctx: PluginContext;
  private started = false;
  private chatHistories = new Map<string, Array<{ role: string; text: string; source?: string }>>();
  private sseClients = new Map<string, Set<ServerResponse>>();
  private unsubscribes: Array<() => void> = [];
  private subscribedActors = new Set<string>();

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus = bus;

    // Register routes on main HTTP server
    this.ctx.registerRoute("GET", "/plugins/actors/", (req: any, res: any) => this.handleGet(req, res));
    this.ctx.registerRoute("POST", "/plugins/actors/", (req: any, res: any) => this.handlePost(req, res));
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    for (const clients of this.sseClients.values()) {
      for (const c of clients) { try { c.end(); } catch {} }
    }
    this.sseClients.clear();
  }

  private ensureSubscribed(actorName: string): void {
    if (this.subscribedActors.has(actorName)) return;
    this.subscribedActors.add(actorName);

    const sessionId = `actor-${actorName}`;

    this.unsubscribes.push(
      this.bus.subscribe(`core.${sessionId}.stream.delta`, (msg: any) => {
        this.broadcast(actorName, { type: "delta", text: msg.text });
      })
    );

    this.unsubscribes.push(
      this.bus.subscribe(`core.${sessionId}.stream.complete`, (msg: any) => {
        const history = this.getHistory(actorName);
        history.push({ role: 'actor', text: msg.fullText });
        if (history.length > MAX_CHAT_HISTORY) history.splice(0, history.length - MAX_CHAT_HISTORY);
        this.broadcast(actorName, { type: "done", fullText: msg.fullText });
      })
    );

    this.unsubscribes.push(
      this.bus.subscribe(`core.${sessionId}.error`, (msg: any) => {
        this.broadcast(actorName, { type: "error", error: msg.error });
      })
    );
  }

  private getHistory(name: string) {
    if (!this.chatHistories.has(name)) this.chatHistories.set(name, []);
    return this.chatHistories.get(name)!;
  }

  private broadcast(actorName: string, data: any): void {
    const clients = this.sseClients.get(actorName);
    if (!clients) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { try { c.write(msg); } catch {} }
  }

  // URL: /plugins/actors/{name}/stream or /plugins/actors/{name}/history or /plugins/actors/{name}/send
  private parseUrl(url: string): { actorName: string; action: string } | null {
    const match = url?.match(/^\/plugins\/actors\/([^/]+)\/(send|stream|history)$/);
    if (!match) return null;
    return { actorName: match[1], action: match[2] };
  }

  private handleGet(req: any, res: any): void {
    const parsed = this.parseUrl(req.url);
    if (!parsed) { res.writeHead(404); res.end(); return; }

    const { actorName, action } = parsed;

    if (action === "stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      this.ensureSubscribed(actorName);
      if (!this.sseClients.has(actorName)) this.sseClients.set(actorName, new Set());
      this.sseClients.get(actorName)!.add(res);
      req.on("close", () => this.sseClients.get(actorName)?.delete(res));
      return;
    }

    if (action === "history") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(this.getHistory(actorName)));
      return;
    }

    res.writeHead(404); res.end();
  }

  private handlePost(req: any, res: any): void {
    const parsed = this.parseUrl(req.url);
    if (!parsed || parsed.action !== "send") { res.writeHead(404); res.end(); return; }

    const { actorName } = parsed;
    let body = "";
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      try {
        const { text } = JSON.parse(body);
        const history = this.getHistory(actorName);
        history.push({ role: 'user', text, source: 'you' });
        this.broadcast(actorName, { type: "user", text, source: "you" });

        this.bus.publish("input.prompt", {
          sessionId: `actor-${actorName}`,
          componentId: "actor-chat",
          text,
        });

        this.ensureSubscribed(actorName);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end();
      }
    });
  }
}
```

- [ ] **Step 2: Copy actor-system.md to plugin**

```bash
cp ~/dev/personal/jarvis-app/app/actor-system.md ~/dev/personal/jarvis-plugin-actors/actor-system.md
```

- [ ] **Step 3: Create pieces/index.ts**

```typescript
import { ActorPoolPiece } from "./actor-pool.js";
import { ActorRunnerPiece } from "./actor-runner.js";
import { ActorChatPiece } from "./actor-chat.js";

interface PluginContext {
  bus: any;
  toolRegistry: any;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: any;
  registerRoute: (method: string, path: string, handler: any) => void;
}

export function createPieces(ctx: PluginContext) {
  return [
    new ActorPoolPiece(ctx),
    new ActorRunnerPiece(ctx),
    new ActorChatPiece(ctx),
  ];
}
```

- [ ] **Step 4: Delete actor-system.md from app**

```bash
cd ~/dev/personal/jarvis-app
git rm app/actor-system.md
git commit -m "chore: remove actor-system.md (moved to actor plugin)"
```

- [ ] **Step 5: Commit plugin**

```bash
cd ~/dev/personal/jarvis-plugin-actors
git add -A
git commit -m "feat: ActorChatPiece + plugin entry + actor-system.md"
```

---

## Task 7: Update ActorChat.tsx URLs and integration test

**Files:**
- Modify: `app/ui/src/components/panels/ActorChat.tsx`

- [ ] **Step 1: Update ActorChat.tsx to use main server**

Replace `ACTOR_PORT` constant and all URL references:

Change line 3:
```typescript
const ACTOR_PORT = 50056
```
To:
```typescript
const ACTOR_BASE = 'http://localhost:50052/plugins/actors'
```

Change line 19 (history fetch):
```typescript
fetch(`http://localhost:${ACTOR_PORT}/${actorName}/history`)
```
To:
```typescript
fetch(`${ACTOR_BASE}/${actorName}/history`)
```

Change line 26 (SSE):
```typescript
const source = new EventSource(`http://localhost:${ACTOR_PORT}/${actorName}/stream`)
```
To:
```typescript
const source = new EventSource(`${ACTOR_BASE}/${actorName}/stream`)
```

Change line 49 (send):
```typescript
fetch(`http://localhost:${ACTOR_PORT}/${actorName}/send`, {
```
To:
```typescript
fetch(`${ACTOR_BASE}/${actorName}/send`, {
```

- [ ] **Step 2: Rebuild UI**

```bash
cd app/ui && npm run build
```

- [ ] **Step 3: Commit**

```bash
cd ~/dev/personal/jarvis-app
git add -A
git commit -m "feat: update ActorChat URLs to use main server plugin routes"
```

- [ ] **Step 4: Create GitHub repo and push plugin**

```bash
cd ~/dev/personal/jarvis-plugin-actors
gh repo create giovanibarili/jarvis-plugin-actors --public --source=. --push
```

- [ ] **Step 5: Integration test — install and validate**

Start JARVIS: `cd ~/dev/personal/jarvis-app/app && npx tsx src/main.ts`

Ask JARVIS: "Install the actors plugin from github.com/giovanibarili/jarvis-plugin-actors"

Verify:
- 3 pieces appear in `piece_list` (actor-pool, actor-runner, actor-chat)
- Actor Pool HUD panel visible
- `actor_dispatch` works — dispatches task, actor runs autonomously
- Actor chat works via `/plugins/actors/{name}/stream` (SSE)
- Port 50056 not used
- `plugin_disable` stops all 3 pieces

- [ ] **Step 6: Push jarvis-app changes**

```bash
cd ~/dev/personal/jarvis-app
git push
```

- [ ] **Step 7: Update MARKETPLACE.md**

Add actors plugin entry to MARKETPLACE.md:

```markdown
### Actor Pool

Persistent AI actor pool for autonomous task delegation. Create named actors with roles (generic, researcher, coder, reviewer) that maintain conversation memory across tasks. Actors execute autonomously with tool access and report results back to the main session.

**Repo:** [github.com/giovanibarili/jarvis-plugin-actors](https://github.com/giovanibarili/jarvis-plugin-actors)

**Provides:** ActorPoolPiece (lifecycle/tools/HUD), ActorRunnerPiece (task execution), ActorChatPiece (HTTP routes/SSE), 4 tools (actor_dispatch, actor_list, actor_kill, bus_publish)

**Requires:** Nothing — uses JARVIS AI sessions via PluginContext
```

Commit and push.

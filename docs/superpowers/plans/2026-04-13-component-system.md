# Component System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the app into a component-based architecture where each feature is a pluggable component with lifecycle, dependency resolution, and optional HUD representation.

**Architecture:** Components implement a shared interface with start/stop/getHudConfig/getData. A ComponentRegistry manages lifecycle and dependency order. Jarvis builds HudState by iterating active components. Frontend renders dynamically from a renderer map.

**Tech Stack:** TypeScript, existing stack (no new deps)

---

## File Map

```
src/
  components/
    types.ts               — NEW: Component interface + HudComponentConfig + ComponentConfig
    registry.ts            — NEW: ComponentRegistry class
    jarvis-core.ts         — NEW: JarvisCore component (extracts from jarvis.ts)
    chat.ts                — NEW: Chat component (wraps CliRepl + queue interaction)
    grpc.ts                — NEW: gRPC component (wraps GrpcServer)
    logs.ts                — NEW: LogViewer component (minimal — SSE is already in HTTP server)
    mind-map.ts            — NEW: MindMap component (metric nodes)
  config/index.ts          — MODIFY: add components config
  main.ts                  — REWRITE: register components, start via registry
  jarvis/jarvis.ts         — MODIFY: slim down, delegate to JarvisCore component
ui/src/
  types/hud.ts             — REWRITE: HudComponentState replaces old types
  components/
    HudRenderer.tsx         — REWRITE: render from components[] via renderer map
    renderers/
      index.ts              — NEW: renderer map
      JarvisCoreRenderer.tsx — NEW: VoiceOrb rendering
      ChatRenderer.tsx       — NEW: ChatPanel rendering
      GrpcRenderer.tsx       — NEW: gRPC indicator
      LogsRenderer.tsx       — NEW: LogPanel rendering
      MindMapRenderer.tsx    — NEW: MindMapNodes rendering
```

---

### Task 1: Component Types

**Files:**
- Create: `src/components/types.ts`

- [ ] **Step 1: Create component types**

```typescript
// src/components/types.ts
export type ComponentStatus = "running" | "stopped" | "starting" | "stopping" | "error";

export type HudComponentConfig = {
  type: "panel" | "overlay" | "indicator";
  draggable: boolean;
  resizable: boolean;
};

export type ComponentConfig = {
  startOnBoot: boolean;
  permanent: boolean;
};

export interface Component {
  readonly id: string;
  readonly name: string;
  readonly dependencies: string[];
  readonly permanent: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;

  getHudConfig(): HudComponentConfig | null;
  getData(): Record<string, unknown>;
  getStatus(): ComponentStatus;
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/personal/jarvis-app && mkdir -p src/components && git add src/components/types.ts
git commit -m "feat(components): add Component interface and types"
```

---

### Task 2: ComponentRegistry

**Files:**
- Create: `src/components/registry.ts`

- [ ] **Step 1: Create registry**

```typescript
// src/components/registry.ts
import type { Component } from "./types.js";
import { log } from "../logger/index.js";

export class ComponentRegistry {
  private components = new Map<string, Component>();

  register(component: Component): void {
    if (this.components.has(component.id)) {
      throw new Error(`Component '${component.id}' already registered`);
    }
    this.components.set(component.id, component);
    log.info({ id: component.id, name: component.name }, "Component registered");
  }

  async start(id: string): Promise<void> {
    const component = this.get(id);
    if (!component) throw new Error(`Component '${id}' not found`);
    if (component.getStatus() === "running") return;

    // Start dependencies first
    for (const depId of component.dependencies) {
      const dep = this.get(depId);
      if (!dep) throw new Error(`Dependency '${depId}' for '${id}' not found`);
      if (dep.getStatus() !== "running") {
        log.info({ id, dependency: depId }, "Starting dependency first");
        await this.start(depId);
      }
    }

    log.info({ id }, "Starting component");
    await component.start();
    log.info({ id, status: component.getStatus() }, "Component started");
  }

  async stop(id: string): Promise<void> {
    const component = this.get(id);
    if (!component) throw new Error(`Component '${id}' not found`);
    if (component.getStatus() === "stopped") return;

    if (component.permanent) {
      throw new Error(`Component '${id}' is permanent and cannot be stopped`);
    }

    // Check if any running component depends on this one
    for (const [otherId, other] of this.components) {
      if (other.getStatus() === "running" && other.dependencies.includes(id)) {
        throw new Error(`Cannot stop '${id}': component '${otherId}' depends on it`);
      }
    }

    log.info({ id }, "Stopping component");
    await component.stop();
    log.info({ id, status: component.getStatus() }, "Component stopped");
  }

  async startAll(ids: string[]): Promise<void> {
    // Topological sort
    const sorted = this.topoSort(ids);
    for (const id of sorted) {
      await this.start(id);
    }
  }

  async stopAll(): Promise<void> {
    // Stop in reverse dependency order — non-permanent first, then permanent
    const running = [...this.components.values()].filter(c => c.getStatus() === "running");
    const sorted = this.topoSort(running.map(c => c.id)).reverse();

    for (const id of sorted) {
      const c = this.get(id);
      if (c && c.getStatus() === "running") {
        try {
          await c.stop();
          log.info({ id }, "Component stopped (shutdown)");
        } catch (err) {
          log.error({ id, err }, "Error stopping component during shutdown");
        }
      }
    }
  }

  get(id: string): Component | undefined {
    return this.components.get(id);
  }

  getActive(): Component[] {
    return [...this.components.values()].filter(c => c.getStatus() === "running");
  }

  getAll(): Component[] {
    return [...this.components.values()];
  }

  private topoSort(ids: string[]): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const comp = this.get(id);
      if (comp) {
        for (const depId of comp.dependencies) {
          visit(depId);
        }
      }
      result.push(id);
    };

    for (const id of ids) visit(id);
    return result;
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/personal/jarvis-app && git add src/components/registry.ts
git commit -m "feat(components): add ComponentRegistry with dependency resolution"
```

---

### Task 3: JarvisCore Component

**Files:**
- Create: `src/components/jarvis-core.ts`

- [ ] **Step 1: Create JarvisCore**

This extracts the core Jarvis functionality (session, queue, actors, bootstrap, event loop) into a component. The existing `jarvis.ts` will be removed later.

```typescript
// src/components/jarvis-core.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AISession, AISessionFactory } from "../ai/types.js";
import { ActorPool } from "../actors/actor-pool.js";
import { MessageQueue } from "../queue/message-queue.js";
import { log } from "../logger/index.js";
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";

type JarvisState = "initializing" | "loading" | "online" | "processing" | "offline";

function formatUptime(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const INSTRUCTION_FILES = [join(homedir(), ".claude", "CLAUDE.md")];

export class JarvisCore implements Component {
  readonly id = "jarvis-core";
  readonly name = "Jarvis Core";
  readonly dependencies: string[] = [];
  readonly permanent = true;

  private session: AISession;
  readonly actorPool: ActorPool;
  readonly queue: MessageQueue;
  private running = false;
  private state: JarvisState = "initializing";
  private totalRequests = 0;
  private totalResponseTimeMs = 0;
  private lastResponseTimeMs = 0;
  private upSince = Date.now();

  constructor(factory: AISessionFactory, queue: MessageQueue) {
    this.session = factory.create("jarvis-lead");
    this.actorPool = new ActorPool(factory);
    this.queue = queue;
  }

  async start(): Promise<void> {
    this.running = true;
    this.upSince = Date.now();

    await this.bootstrap();

    this.state = "online";
    log.info("JarvisCore: event loop started");

    // Event loop runs detached — start() returns so registry can continue
    this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.state = "offline";
    this.session.close();
    this.actorPool.destroyAll();
    log.info("JarvisCore: stopped");
  }

  getHudConfig(): HudComponentConfig {
    return { type: "overlay", draggable: true, resizable: true };
  }

  getData(): Record<string, unknown> {
    return {
      status: this.state,
      coreLabel: this.state.toUpperCase(),
      coreSubLabel: formatUptime(this.upSince),
      totalRequests: this.totalRequests,
      lastResponseMs: this.lastResponseTimeMs,
      queueSize: this.queue.size,
      activeActors: this.actorPool.size,
    };
  }

  getStatus(): ComponentStatus {
    if (!this.running) return "stopped";
    if (this.state === "initializing" || this.state === "loading") return "starting";
    return "running";
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const msg = await this.queue.dequeue();
      if (!this.running) break;

      const target = msg.clientId ? `actor:${msg.clientId}` : "jarvis-lead";
      log.info({ id: msg.id, target, prompt: msg.prompt.slice(0, 80) }, "JarvisCore: dequeued");

      try {
        this.state = "processing";
        const t0 = Date.now();

        const result = msg.clientId
          ? await this.actorPool.get(msg.clientId).process(msg.prompt)
          : await this.processDirectly(msg.prompt);

        this.lastResponseTimeMs = Date.now() - t0;
        this.totalResponseTimeMs += this.lastResponseTimeMs;
        this.totalRequests++;
        this.state = "online";

        msg.resolve(result);
      } catch (err) {
        this.state = "online";
        log.error({ err, id: msg.id }, "JarvisCore: failed");
        msg.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async processDirectly(prompt: string): Promise<string> {
    const t0 = Date.now();
    await this.session.send(prompt);
    let result = "";
    for await (const msg of this.session.stream()) {
      if (msg.type === "result" && msg.result) result = msg.result;
    }
    log.info({ ms: Date.now() - t0, resultLength: result.length }, "JarvisCore: processed");
    return result;
  }

  private async bootstrap(): Promise<void> {
    this.state = "loading";
    log.info("JarvisCore: bootstrap started");

    const instructions: string[] = [];
    for (const filePath of INSTRUCTION_FILES) {
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8");
        instructions.push(`# Instructions from ${filePath}\n\n${content}`);
        log.info({ file: filePath, size: content.length }, "JarvisCore: loaded instruction file");
      }
    }

    const localClaudeMd = join(process.cwd(), "CLAUDE.md");
    if (existsSync(localClaudeMd)) {
      const content = readFileSync(localClaudeMd, "utf-8");
      instructions.push(`# Project instructions from ${localClaudeMd}\n\n${content}`);
    }

    if (instructions.length > 0) {
      const prompt = ["You are JARVIS. The following are your operating instructions. Read, internalize, and follow them for the entire session. Do not summarize them back — just confirm you are ready with a short greeting.", "", ...instructions].join("\n");
      await this.session.send(prompt);
      for await (const msg of this.session.stream()) { /* consume ack */ }
      log.info("JarvisCore: bootstrap complete");
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/personal/jarvis-app && git add src/components/jarvis-core.ts
git commit -m "feat(components): add JarvisCore component with event loop and bootstrap"
```

---

### Task 4: Remaining Components (Chat, gRPC, Logs, MindMap)

**Files:**
- Create: `src/components/chat.ts`
- Create: `src/components/grpc.ts`
- Create: `src/components/logs.ts`
- Create: `src/components/mind-map.ts`

- [ ] **Step 1: Create Chat component**

```typescript
// src/components/chat.ts
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";
import type { JarvisCore } from "./jarvis-core.js";
import { CliRepl } from "../transport/cli/repl.js";
import { log } from "../logger/index.js";

export class ChatComponent implements Component {
  readonly id = "chat";
  readonly name = "Chat";
  readonly dependencies = ["jarvis-core"];
  readonly permanent = true;

  private repl: CliRepl | null = null;
  private status: ComponentStatus = "stopped";
  private jarvisCore: JarvisCore;

  constructor(jarvisCore: JarvisCore) {
    this.jarvisCore = jarvisCore;
  }

  async start(): Promise<void> {
    this.status = "starting";
    this.repl = new CliRepl(this.jarvisCore.queue);
    this.status = "running";
    log.info("ChatComponent: started");
    // REPL runs in foreground — start() returns, repl.start() called from main
    this.repl.start();
  }

  async stop(): Promise<void> {
    this.status = "stopping";
    if (this.repl) this.repl.stop();
    this.repl = null;
    this.status = "stopped";
    log.info("ChatComponent: stopped");
  }

  getHudConfig(): HudComponentConfig {
    return { type: "panel", draggable: true, resizable: true };
  }

  getData(): Record<string, unknown> {
    return {};
  }

  getStatus(): ComponentStatus {
    return this.status;
  }
}
```

- [ ] **Step 2: Create gRPC component**

```typescript
// src/components/grpc.ts
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";
import type { JarvisCore } from "./jarvis-core.js";
import { GrpcServer } from "../transport/grpc/server.js";
import { log } from "../logger/index.js";

export class GrpcComponent implements Component {
  readonly id = "grpc";
  readonly name = "gRPC Server";
  readonly dependencies = ["jarvis-core"];
  readonly permanent = false;

  private server: GrpcServer | null = null;
  private status: ComponentStatus = "stopped";
  private port = 0;
  private jarvisCore: JarvisCore;

  constructor(jarvisCore: JarvisCore) {
    this.jarvisCore = jarvisCore;
  }

  async start(): Promise<void> {
    this.status = "starting";
    this.server = new GrpcServer(this.jarvisCore.queue);
    this.port = await this.server.start();
    this.status = "running";
    log.info({ port: this.port }, "GrpcComponent: started");
  }

  async stop(): Promise<void> {
    this.status = "stopping";
    if (this.server) this.server.stop();
    this.server = null;
    this.port = 0;
    this.status = "stopped";
    log.info("GrpcComponent: stopped");
  }

  getHudConfig(): HudComponentConfig {
    return { type: "indicator", draggable: true, resizable: false };
  }

  getData(): Record<string, unknown> {
    return { port: this.port, connected: this.status === "running" };
  }

  getStatus(): ComponentStatus {
    return this.status;
  }
}
```

- [ ] **Step 3: Create Logs component**

```typescript
// src/components/logs.ts
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";
import { log } from "../logger/index.js";

export class LogsComponent implements Component {
  readonly id = "logs";
  readonly name = "Log Viewer";
  readonly dependencies: string[] = [];
  readonly permanent = false;

  private status: ComponentStatus = "stopped";

  async start(): Promise<void> {
    this.status = "running";
    log.info("LogsComponent: started");
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    log.info("LogsComponent: stopped");
  }

  getHudConfig(): HudComponentConfig {
    return { type: "panel", draggable: true, resizable: true };
  }

  getData(): Record<string, unknown> {
    return {};
  }

  getStatus(): ComponentStatus {
    return this.status;
  }
}
```

- [ ] **Step 4: Create MindMap component**

```typescript
// src/components/mind-map.ts
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";
import type { JarvisCore } from "./jarvis-core.js";
import { log } from "../logger/index.js";

export class MindMapComponent implements Component {
  readonly id = "mind-map";
  readonly name = "Mind Map";
  readonly dependencies = ["jarvis-core"];
  readonly permanent = false;

  private status: ComponentStatus = "stopped";
  private jarvisCore: JarvisCore;

  constructor(jarvisCore: JarvisCore) {
    this.jarvisCore = jarvisCore;
  }

  async start(): Promise<void> {
    this.status = "running";
    log.info("MindMapComponent: started");
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    log.info("MindMapComponent: stopped");
  }

  getHudConfig(): HudComponentConfig {
    return { type: "overlay", draggable: true, resizable: true };
  }

  getData(): Record<string, unknown> {
    const data = this.jarvisCore.getData();
    return {
      nodes: [
        { id: "queue", label: "QUEUE", value: String(data.queueSize), color: "#4af" },
        { id: "actors", label: "ACTORS", value: String(data.activeActors), color: "#a6f" },
        {
          id: "response", label: "RESP",
          value: data.lastResponseMs ? `${(Number(data.lastResponseMs) / 1000).toFixed(1)}s` : "-",
          color: Number(data.lastResponseMs) > 5000 ? "#fa4" : "#4a4",
        },
        { id: "requests", label: "REQS", value: String(data.totalRequests), color: "#4af" },
      ],
    };
  }

  getStatus(): ComponentStatus {
    return this.status;
  }
}
```

- [ ] **Step 5: Commit**

```bash
cd ~/dev/personal/jarvis-app && git add src/components/chat.ts src/components/grpc.ts src/components/logs.ts src/components/mind-map.ts
git commit -m "feat(components): add Chat, gRPC, Logs, MindMap components"
```

---

### Task 5: Config Update

**Files:**
- Modify: `src/config/index.ts`

- [ ] **Step 1: Add component configs**

Add to `src/config/index.ts`:

```typescript
export interface ComponentConfig {
  startOnBoot: boolean;
  permanent: boolean;
}

export interface JarvisConfig {
  model: string;
  allowedTools: string[];
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  grpcPort: number;
  logLevel: string;
  components: Record<string, ComponentConfig>;
}

export const config: JarvisConfig = {
  model: process.env.JARVIS_MODEL ?? "claude-sonnet-4-6",
  allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  permissionMode: "bypassPermissions",
  grpcPort: Number(process.env.JARVIS_GRPC_PORT ?? "50051"),
  logLevel: process.env.LOG_LEVEL ?? "info",
  components: {
    "jarvis-core": { startOnBoot: true, permanent: true },
    "chat":        { startOnBoot: true, permanent: true },
    "grpc":        { startOnBoot: false, permanent: false },
    "logs":        { startOnBoot: false, permanent: false },
    "mind-map":    { startOnBoot: true, permanent: false },
  },
};
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/personal/jarvis-app && git add src/config/index.ts
git commit -m "feat(components): add component configs to JarvisConfig"
```

---

### Task 6: Rewrite main.ts + HUD State Builder

**Files:**
- Rewrite: `src/main.ts`
- Modify: `src/transport/http/status-server.ts` — update /hud to use new component-based state

- [ ] **Step 1: Rewrite main.ts**

```typescript
// src/main.ts
import { ClaudeAgentSessionFactory } from "./ai/claude-agent/adapter.js";
import { MessageQueue } from "./queue/message-queue.js";
import { ComponentRegistry } from "./components/registry.js";
import { JarvisCore } from "./components/jarvis-core.js";
import { ChatComponent } from "./components/chat.js";
import { GrpcComponent } from "./components/grpc.js";
import { LogsComponent } from "./components/logs.js";
import { MindMapComponent } from "./components/mind-map.js";
import { StatusServer } from "./transport/http/status-server.js";
import { config } from "./config/index.js";
import { log } from "./logger/index.js";
import { launchHud } from "./transport/hud/electron.js";

function buildHudState(registry: ComponentRegistry, jarvisCore: JarvisCore) {
  const components = registry.getActive()
    .filter(c => c.getHudConfig() !== null)
    .map(c => {
      const hudConfig = c.getHudConfig()!;
      const data = c.getData();
      return {
        id: c.id,
        name: c.name,
        status: c.getStatus(),
        hudConfig,
        position: data.position as { x: number; y: number } | undefined ?? { x: 0, y: 0 },
        size: data.size as { width: number; height: number } | undefined ?? { width: 200, height: 200 },
        data,
      };
    });

  const coreData = jarvisCore.getData();
  return {
    reactor: {
      status: coreData.status as string,
      coreLabel: coreData.coreLabel as string,
      coreSubLabel: coreData.coreSubLabel as string,
    },
    components,
  };
}

async function main() {
  const factory = new ClaudeAgentSessionFactory();
  const queue = new MessageQueue();
  const registry = new ComponentRegistry();

  // Create components
  const jarvisCore = new JarvisCore(factory, queue);
  const chat = new ChatComponent(jarvisCore);
  const grpc = new GrpcComponent(jarvisCore);
  const logs = new LogsComponent();
  const mindMap = new MindMapComponent(jarvisCore);

  // Register all
  registry.register(jarvisCore);
  registry.register(chat);
  registry.register(grpc);
  registry.register(logs);
  registry.register(mindMap);

  // Start components marked startOnBoot
  const bootIds = Object.entries(config.components)
    .filter(([_, cfg]) => cfg.startOnBoot)
    .map(([id]) => id);
  await registry.startAll(bootIds);

  // HTTP server for HUD
  const statusServer = new StatusServer(50052, () => buildHudState(registry, jarvisCore));
  statusServer.setChatHandler((prompt) => queue.enqueue(prompt, ""));

  console.log("JARVIS online");
  console.log(`HUD  ${statusServer.url}\n`);

  launchHud(statusServer.url);

  process.on("SIGINT", async () => {
    log.info("Shutting down...");
    await registry.stopAll();
    statusServer.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  log.fatal({ err }, "Startup failed");
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/personal/jarvis-app && git add src/main.ts
git commit -m "feat(components): rewrite main.ts with ComponentRegistry boot sequence"
```

---

### Task 7: Frontend — Updated HUD Types + Renderer Map

**Files:**
- Rewrite: `ui/src/types/hud.ts`
- Create: `ui/src/components/renderers/index.ts`
- Create: `ui/src/components/renderers/JarvisCoreRenderer.tsx`
- Create: `ui/src/components/renderers/ChatRenderer.tsx`
- Create: `ui/src/components/renderers/GrpcRenderer.tsx`
- Create: `ui/src/components/renderers/LogsRenderer.tsx`
- Create: `ui/src/components/renderers/MindMapRenderer.tsx`
- Rewrite: `ui/src/components/HudRenderer.tsx`

- [ ] **Step 1: Rewrite HUD types**

```typescript
// ui/src/types/hud.ts
export type HudComponentConfig = {
  type: "panel" | "overlay" | "indicator";
  draggable: boolean;
  resizable: boolean;
};

export type HudComponentState = {
  id: string;
  name: string;
  status: string;
  hudConfig: HudComponentConfig;
  position: { x: number; y: number };
  size: { width: number; height: number };
  data: Record<string, unknown>;
};

export type HudReactor = {
  status: string;
  coreLabel: string;
  coreSubLabel: string;
};

export type HudState = {
  reactor: HudReactor;
  components: HudComponentState[];
};
```

- [ ] **Step 2: Create renderers**

```typescript
// ui/src/components/renderers/JarvisCoreRenderer.tsx
import type { HudComponentState } from '../../types/hud'
import { ReactorCore } from '../ReactorCore'

export function JarvisCoreRenderer({ state }: { state: HudComponentState }) {
  const statusColor = state.data.status === 'online' ? '#4af'
    : state.data.status === 'processing' ? '#fa4'
    : state.data.status === 'loading' ? '#a6f'
    : '#f44'

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
      <ReactorCore reactor={{ status: state.data.status as string, coreLabel: state.data.coreLabel as string, coreSubLabel: state.data.coreSubLabel as string }} size={160} />
      <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '6px', color: statusColor, marginTop: '-8px' }}>
        JARVIS
      </div>
    </div>
  )
}
```

```typescript
// ui/src/components/renderers/ChatRenderer.tsx
import type { HudComponentState } from '../../types/hud'
import { ChatPanel } from '../panels/ChatPanel'

export function ChatRenderer({ state }: { state: HudComponentState }) {
  return <ChatPanel disabled={state.status !== 'running'} />
}
```

```typescript
// ui/src/components/renderers/GrpcRenderer.tsx
import type { HudComponentState } from '../../types/hud'

export function GrpcRenderer({ state }: { state: HudComponentState }) {
  const port = state.data.port as number
  const connected = state.data.connected as boolean
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px', fontSize: '10px', color: '#668' }}>
      <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: connected ? '#4a4' : '#a44', boxShadow: connected ? '0 0 6px #4a4' : 'none' }} />
      <span style={{ fontFamily: 'Orbitron, sans-serif', letterSpacing: '1px' }}>gRPC</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>:{port}</span>
    </div>
  )
}
```

```typescript
// ui/src/components/renderers/LogsRenderer.tsx
import type { HudComponentState } from '../../types/hud'
import { LogPanel } from '../LogPanel'

export function LogsRenderer({ state }: { state: HudComponentState }) {
  return <LogPanel />
}
```

```typescript
// ui/src/components/renderers/MindMapRenderer.tsx
import type { HudComponentState } from '../../types/hud'
import { MindMapNodes } from '../MindMapNodes'

type Node = { id: string; label: string; value: string; color: string }

export function MindMapRenderer({ state }: { state: HudComponentState }) {
  const nodes = (state.data.nodes as Node[]) ?? []
  const svgSize = 300
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${svgSize} ${svgSize}`} style={{ pointerEvents: 'none' }}>
      <MindMapNodes nodes={nodes} cx={svgSize / 2} cy={svgSize / 2} innerRadius={50} outerRadius={svgSize / 2 * 0.85} />
    </svg>
  )
}
```

```typescript
// ui/src/components/renderers/index.ts
import type { ReactNode } from 'react'
import type { HudComponentState } from '../../types/hud'
import { JarvisCoreRenderer } from './JarvisCoreRenderer'
import { ChatRenderer } from './ChatRenderer'
import { GrpcRenderer } from './GrpcRenderer'
import { LogsRenderer } from './LogsRenderer'
import { MindMapRenderer } from './MindMapRenderer'

type Renderer = (props: { state: HudComponentState }) => ReactNode

export const renderers: Record<string, Renderer> = {
  "jarvis-core": JarvisCoreRenderer,
  "chat": ChatRenderer,
  "grpc": GrpcRenderer,
  "logs": LogsRenderer,
  "mind-map": MindMapRenderer,
}
```

- [ ] **Step 3: Rewrite HudRenderer**

```typescript
// ui/src/components/HudRenderer.tsx
import type { HudState } from '../types/hud'
import { DraggablePanel } from './DraggablePanel'
import { renderers } from './renderers/index'

export function HudRenderer({ state }: { state: HudState }) {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {state.components.map(comp => {
        const Renderer = renderers[comp.id]
        if (!Renderer) return null

        return (
          <DraggablePanel
            key={comp.id}
            id={comp.name.toUpperCase()}
            defaultX={comp.position.x}
            defaultY={comp.position.y}
            defaultWidth={comp.size.width}
            defaultHeight={comp.size.height}
            minWidth={100}
            minHeight={60}
            borderColor={comp.hudConfig.type === 'panel' ? '#1a2a3a' : 'transparent'}
          >
            <Renderer state={comp} />
          </DraggablePanel>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
cd ~/dev/personal/jarvis-app && mkdir -p ui/src/components/renderers
git add ui/src/types/hud.ts ui/src/components/renderers/ ui/src/components/HudRenderer.tsx
git commit -m "feat(components): dynamic HUD renderer with component-based state"
```

---

### Task 8: Cleanup + Build

**Files:**
- Delete: `src/jarvis/jarvis.ts` (replaced by JarvisCore component)
- Delete: `src/jarvis/` directory
- Delete: `ui/src/components/PanelRenderer.tsx` (replaced by dynamic rendering)
- Build: `ui/` — `npx vite build`

- [ ] **Step 1: Delete old files**

```bash
cd ~/dev/personal/jarvis-app
rm -rf src/jarvis/
rm ui/src/components/PanelRenderer.tsx
```

- [ ] **Step 2: Build frontend**

```bash
cd ~/dev/personal/jarvis-app/ui && npx vite build
```

If build fails, fix import errors (likely stale imports to deleted files).

- [ ] **Step 3: Verify system starts**

```bash
cd ~/dev/personal/jarvis-app && npx tsx -e "
import { ComponentRegistry } from './src/components/registry.ts';
import { JarvisCore } from './src/components/jarvis-core.ts';
console.log('Imports OK');
"
```

- [ ] **Step 4: Commit**

```bash
cd ~/dev/personal/jarvis-app && git add -A && git add -f ui/dist/
git commit -m "feat(components): Component System complete

- Component interface with lifecycle (start/stop/getHudConfig/getData)
- ComponentRegistry with dependency resolution and topological sort
- 5 components: JarvisCore, Chat, gRPC, Logs, MindMap
- Config-driven boot sequence (startOnBoot, permanent)
- Dynamic HUD rendering via renderer map
- Removed old jarvis.ts and PanelRenderer"
```

---

## Self-Review

**Spec coverage:** Component interface (T1), Registry (T2), JarvisCore (T3), all 5 components (T3+T4), config (T5), main.ts rewrite (T6), frontend types + renderers (T7), cleanup (T8). All spec sections covered.

**Placeholder scan:** All code complete — no TBDs.

**Type consistency:** `Component`, `ComponentStatus`, `HudComponentConfig`, `HudComponentState` used consistently. `getData()` returns `Record<string, unknown>` everywhere. Registry methods match spec (`start`, `stop`, `startAll`, `stopAll`, `getActive`, `getAll`).

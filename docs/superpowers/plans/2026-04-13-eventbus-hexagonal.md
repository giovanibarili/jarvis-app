# EventBus + Hexagonal Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MessageQueue with EventBus, restructure JARVIS into hexagonal architecture with event-driven state machine core.

**Architecture:** EventBus at center. Input adapters publish `input.*`, JarvisCore subscribes and publishes `core.*`, viewers/tools subscribe to `core.*`. JarvisCore is a state machine (IDLE→PROCESSING→WAITING_TOOLS). Sessions managed by sessionId. No polling, no direct method calls between components.

**Tech Stack:** TypeScript, Node.js EventEmitter (for bus internals), @anthropic-ai/sdk, @modelcontextprotocol/sdk

---

### Task 1: Create EventBus and core types

**Files:**
- Create: `src/core/bus.ts`
- Create: `src/core/types.ts`

- [ ] **Step 1: Create `src/core/types.ts`**

```typescript
// src/core/types.ts
import type { ToolCall, ToolResult } from "../ai/types.js";

export interface BusMessage {
  id: string;
  timestamp: number;
  sessionId: string;
  componentId: string;
}

export interface InputPromptEvent extends BusMessage {
  text: string;
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

export interface ApiUsageEvent extends BusMessage {
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export interface ComponentLifecycleEvent extends BusMessage {
  name: string;
  status: string;
}

export type EventHandler<T extends BusMessage = BusMessage> = (msg: T) => void | Promise<void>;
```

- [ ] **Step 2: Create `src/core/bus.ts`**

```typescript
// src/core/bus.ts
import { log } from "../logger/index.js";
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
    log.debug({ topic, sessionId: msg.sessionId, componentId: msg.componentId, eventId: msg.id }, "bus: publish");

    for (const sub of this.subscriptions) {
      const match = sub.pattern ? sub.pattern.test(topic) : sub.topic === topic;
      if (match) {
        try {
          const result = sub.handler(msg);
          if (result instanceof Promise) {
            result.catch(err => log.error({ topic, err }, "bus: handler error"));
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

- [ ] **Step 3: Verify types compile**

```bash
cd ~/dev/personal/jarvis-app && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/core/
git commit -m "feat: implement EventBus with publish/subscribe/subscribePattern"
```

---

### Task 2: Create SessionManager

**Files:**
- Create: `src/core/session-manager.ts`
- Modify: `src/ai/anthropic/factory.ts` (no changes needed, already creates sessions)

- [ ] **Step 1: Create `src/core/session-manager.ts`**

```typescript
// src/core/session-manager.ts
import type { AISession, AISessionFactory } from "../ai/types.js";
import { log } from "../logger/index.js";

type SessionState = "idle" | "processing" | "waiting_tools";

interface ManagedSession {
  session: AISession;
  state: SessionState;
  createdAt: number;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private factory: AISessionFactory;

  constructor(factory: AISessionFactory) {
    this.factory = factory;
  }

  get(sessionId: string): ManagedSession {
    let managed = this.sessions.get(sessionId);
    if (!managed) {
      managed = {
        session: this.factory.create({ label: sessionId }),
        state: "idle",
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, managed);
      log.info({ sessionId }, "SessionManager: created new session");
    }
    return managed;
  }

  setState(sessionId: string, state: SessionState): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.state = state;
      log.debug({ sessionId, state }, "SessionManager: state changed");
    }
  }

  getState(sessionId: string): SessionState {
    return this.sessions.get(sessionId)?.state ?? "idle";
  }

  close(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.session.close();
      this.sessions.delete(sessionId);
      log.info({ sessionId }, "SessionManager: closed");
    }
  }

  closeAll(): void {
    for (const [id] of this.sessions) this.close(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/session-manager.ts
git commit -m "feat: implement SessionManager — per-sessionId AI session lifecycle"
```

---

### Task 3: Create JarvisCore state machine

**Files:**
- Create: `src/core/jarvis.ts`

This is the core state machine. Subscribes to `input.prompt` and `core.*.tool.result`. Publishes `core.{sessionId}.stream.delta`, `core.{sessionId}.stream.complete`, `core.{sessionId}.tool.request`, `core.api.usage`.

- [ ] **Step 1: Create `src/core/jarvis.ts`**

```typescript
// src/core/jarvis.ts
import type { EventBus } from "./bus.js";
import type { SessionManager } from "./session-manager.js";
import type {
  InputPromptEvent,
  StreamDeltaEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  ToolRequestEvent,
  ToolResultEvent,
  ApiUsageEvent,
} from "./types.js";
import type { AIStreamEvent, ToolCall } from "../ai/types.js";
import { log } from "../logger/index.js";

export class JarvisCore {
  private bus: EventBus;
  private sessions: SessionManager;
  private totalRequests = 0;
  private lastResponseMs = 0;

  constructor(bus: EventBus, sessions: SessionManager) {
    this.bus = bus;
    this.sessions = sessions;

    // Subscribe to input prompts
    this.bus.subscribe<InputPromptEvent>("input.prompt", (msg) => this.handlePrompt(msg));

    // Subscribe to tool results (all sessions)
    this.bus.subscribePattern<ToolResultEvent>("core.*.tool.result", (msg) => this.handleToolResult(msg));

    log.info("JarvisCore: initialized (event-driven)");
  }

  private async handlePrompt(msg: InputPromptEvent): Promise<void> {
    const { sessionId, text } = msg;
    const managed = this.sessions.get(sessionId);

    if (managed.state !== "idle") {
      log.warn({ sessionId, state: managed.state }, "JarvisCore: session busy, ignoring prompt");
      return;
    }

    this.sessions.setState(sessionId, "processing");
    const t0 = Date.now();
    log.info({ sessionId, prompt: text.slice(0, 80) }, "JarvisCore: processing prompt");

    try {
      const stream = managed.session.sendAndStream(text);
      await this.consumeStream(sessionId, msg.componentId, stream);
    } catch (err) {
      this.sessions.setState(sessionId, "idle");
      this.bus.publish<StreamErrorEvent>(`core.${sessionId}.error`, {
        sessionId,
        componentId: "jarvis-core",
        error: String(err),
      });
      log.error({ sessionId, err }, "JarvisCore: processing failed");
    }

    this.lastResponseMs = Date.now() - t0;
    this.totalRequests++;
  }

  private async handleToolResult(msg: ToolResultEvent): Promise<void> {
    const { sessionId, results } = msg;
    const managed = this.sessions.get(sessionId);

    if (managed.state !== "waiting_tools") {
      log.warn({ sessionId }, "JarvisCore: received tool result but not waiting");
      return;
    }

    // We need the original tool calls to add results — store them on the session
    const pendingCalls = (managed as any)._pendingToolCalls as ToolCall[] | undefined;
    if (!pendingCalls) {
      log.error({ sessionId }, "JarvisCore: no pending tool calls");
      return;
    }

    managed.session.addToolResults(pendingCalls, results);
    delete (managed as any)._pendingToolCalls;

    this.sessions.setState(sessionId, "processing");

    try {
      const stream = managed.session.continueAndStream();
      await this.consumeStream(sessionId, "jarvis-core", stream);
    } catch (err) {
      this.sessions.setState(sessionId, "idle");
      this.bus.publish<StreamErrorEvent>(`core.${sessionId}.error`, {
        sessionId,
        componentId: "jarvis-core",
        error: String(err),
      });
    }
  }

  private async consumeStream(
    sessionId: string,
    originComponentId: string,
    stream: AsyncGenerator<AIStreamEvent, void>,
  ): Promise<void> {
    let fullText = "";
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          fullText += event.text ?? "";
          this.bus.publish<StreamDeltaEvent>(`core.${sessionId}.stream.delta`, {
            sessionId,
            componentId: "jarvis-core",
            text: event.text ?? "",
          });
          break;
        case "tool_use":
          if (event.toolUse) toolCalls.push(event.toolUse);
          break;
        case "message_complete":
          usage = event.usage;
          break;
        case "error":
          log.error({ sessionId, error: event.error }, "JarvisCore: stream error");
          break;
      }
    }

    // Publish usage
    if (usage) {
      this.bus.publish<ApiUsageEvent>("core.api.usage", {
        sessionId,
        componentId: "jarvis-core",
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        model: "claude-sonnet-4-6",
      });
    }

    if (toolCalls.length > 0) {
      // Store pending calls for when result comes back
      const managed = this.sessions.get(sessionId);
      (managed as any)._pendingToolCalls = toolCalls;
      this.sessions.setState(sessionId, "waiting_tools");

      this.bus.publish<ToolRequestEvent>(`core.${sessionId}.tool.request`, {
        sessionId,
        componentId: "jarvis-core",
        calls: toolCalls,
      });
    } else {
      // Done — publish complete
      this.sessions.setState(sessionId, "idle");
      this.bus.publish<StreamCompleteEvent>(`core.${sessionId}.stream.complete`, {
        sessionId,
        componentId: "jarvis-core",
        fullText,
        usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      });
    }
  }

  getData(): Record<string, unknown> {
    return {
      status: "online",
      coreLabel: "ONLINE",
      totalRequests: this.totalRequests,
      lastResponseMs: this.lastResponseMs,
      activeSessions: this.sessions.size,
    };
  }

  stop(): void {
    this.sessions.closeAll();
    log.info("JarvisCore: stopped");
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/jarvis.ts
git commit -m "feat: JarvisCore as event-driven state machine"
```

---

### Task 4: Create ToolExecutor (event-driven)

**Files:**
- Create: `src/tools/executor.ts`
- Create: `src/tools/registry.ts`

- [ ] **Step 1: Create `src/tools/registry.ts`**

```typescript
// src/tools/registry.ts
import type { ToolCall, ToolResult } from "../ai/types.js";
import { log } from "../logger/index.js";

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: ToolHandler;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
    log.info({ name: def.name }, "ToolRegistry: registered");
  }

  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return [...this.tools.values()].map(({ name, description, input_schema }) => ({
      name, description, input_schema,
    }));
  }

  async execute(calls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(
      calls.map(async (tc) => {
        const def = this.tools.get(tc.name);
        if (!def) {
          return { tool_use_id: tc.id, content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }), is_error: true };
        }
        try {
          const result = await def.handler(tc.input);
          return { tool_use_id: tc.id, content: JSON.stringify(result) };
        } catch (err) {
          log.error({ tool: tc.name, err }, "ToolRegistry: handler error");
          return { tool_use_id: tc.id, content: JSON.stringify({ error: String(err) }), is_error: true };
        }
      })
    );
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }
}
```

- [ ] **Step 2: Create `src/tools/executor.ts`**

```typescript
// src/tools/executor.ts
import type { EventBus } from "../core/bus.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolRequestEvent, ToolResultEvent } from "../core/types.js";
import { log } from "../logger/index.js";

export class ToolExecutor {
  private bus: EventBus;
  private registry: ToolRegistry;
  private totalCalls = 0;
  private totalErrors = 0;
  private totalTimeMs = 0;
  private callsPerTool = new Map<string, number>();

  constructor(bus: EventBus, registry: ToolRegistry) {
    this.bus = bus;
    this.registry = registry;

    // Subscribe to all tool requests
    this.bus.subscribePattern<ToolRequestEvent>("core.*.tool.request", (msg) => this.handleRequest(msg));

    log.info("ToolExecutor: initialized (event-driven)");
  }

  private async handleRequest(msg: ToolRequestEvent): Promise<void> {
    const { sessionId, calls } = msg;
    const t0 = Date.now();
    log.info({ sessionId, count: calls.length, names: calls.map(c => c.name) }, "ToolExecutor: executing batch");

    const results = await this.registry.execute(calls);

    // Track metrics
    for (const tc of calls) {
      this.callsPerTool.set(tc.name, (this.callsPerTool.get(tc.name) ?? 0) + 1);
    }
    this.totalCalls += calls.length;
    this.totalErrors += results.filter(r => r.is_error).length;
    this.totalTimeMs += Date.now() - t0;

    // Publish results
    this.bus.publish<ToolResultEvent>(`core.${sessionId}.tool.result`, {
      sessionId,
      componentId: "tool-executor",
      results,
    });

    log.info({ sessionId, ms: Date.now() - t0, results: results.length }, "ToolExecutor: batch complete");
  }

  getData(): Record<string, unknown> {
    return {
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      avgTimeMs: this.totalCalls > 0 ? Math.round(this.totalTimeMs / this.totalCalls) : 0,
      tools: this.registry.names,
      callsPerTool: Object.fromEntries(this.callsPerTool),
    };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/
git commit -m "feat: event-driven ToolExecutor + ToolRegistry"
```

---

### Task 5: Create TokenCounter (subscriber)

**Files:**
- Create: `src/output/token-counter.ts`

- [ ] **Step 1: Create `src/output/token-counter.ts`**

```typescript
// src/output/token-counter.ts
import type { EventBus } from "../core/bus.js";
import type { ApiUsageEvent } from "../core/types.js";
import { config } from "../config/index.js";
import { log } from "../logger/index.js";

export class TokenCounter {
  private inputTokens = 0;
  private outputTokens = 0;
  private requestCount = 0;

  constructor(bus: EventBus) {
    bus.subscribe<ApiUsageEvent>("core.api.usage", (msg) => {
      this.inputTokens += msg.input_tokens;
      this.outputTokens += msg.output_tokens;
      this.requestCount++;
      log.debug({ in: msg.input_tokens, out: msg.output_tokens }, "TokenCounter: recorded");
    });
  }

  getData(): Record<string, unknown> {
    return {
      model: config.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      requestCount: this.requestCount,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/output/
git commit -m "feat: TokenCounter as EventBus subscriber"
```

---

### Task 6: Create input adapters (HUD Chat + gRPC)

**Files:**
- Create: `src/input/hud-chat.ts`
- Create: `src/input/grpc.ts`

- [ ] **Step 1: Create `src/input/hud-chat.ts`**

This adapter handles HTTP POST /chat. Publishes `input.prompt`, subscribes to `core.{sessionId}.stream.*` for SSE streaming.

```typescript
// src/input/hud-chat.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventBus } from "../core/bus.js";
import type { InputPromptEvent, StreamDeltaEvent, StreamCompleteEvent, StreamErrorEvent } from "../core/types.js";
import { log } from "../logger/index.js";

const DEFAULT_SESSION = "main";

export class HudChatAdapter {
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { prompt, sessionId } = JSON.parse(body);
        const sid = sessionId ?? DEFAULT_SESSION;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        // Subscribe to streaming events for this session
        const unsubs: Array<() => void> = [];

        unsubs.push(this.bus.subscribe<StreamDeltaEvent>(`core.${sid}.stream.delta`, (msg) => {
          res.write(`data: ${JSON.stringify({ type: "delta", text: msg.text })}\n\n`);
        }));

        unsubs.push(this.bus.subscribe<StreamCompleteEvent>(`core.${sid}.stream.complete`, (msg) => {
          res.write(`data: ${JSON.stringify({ type: "done", fullText: msg.fullText })}\n\n`);
          res.end();
          unsubs.forEach(u => u());
        }));

        unsubs.push(this.bus.subscribe<StreamErrorEvent>(`core.${sid}.error`, (msg) => {
          res.write(`data: ${JSON.stringify({ type: "error", error: msg.error })}\n\n`);
          res.end();
          unsubs.forEach(u => u());
        }));

        // Handle client disconnect
        req.on("close", () => { unsubs.forEach(u => u()); });

        // Publish the prompt
        this.bus.publish<InputPromptEvent>("input.prompt", {
          sessionId: sid,
          componentId: "hud-chat",
          text: prompt,
        });

      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }
}
```

- [ ] **Step 2: Create `src/input/grpc.ts`**

```typescript
// src/input/grpc.ts
import type { EventBus } from "../core/bus.js";
import type { InputPromptEvent, StreamCompleteEvent, StreamErrorEvent } from "../core/types.js";
import { log } from "../logger/index.js";

export class GrpcInputAdapter {
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  async processMessage(prompt: string, clientId: string): Promise<string> {
    const sessionId = clientId ? `grpc-${clientId}` : "main";

    return new Promise<string>((resolve, reject) => {
      const unsubs: Array<() => void> = [];

      unsubs.push(this.bus.subscribe<StreamCompleteEvent>(`core.${sessionId}.stream.complete`, (msg) => {
        unsubs.forEach(u => u());
        resolve(msg.fullText);
      }));

      unsubs.push(this.bus.subscribe<StreamErrorEvent>(`core.${sessionId}.error`, (msg) => {
        unsubs.forEach(u => u());
        reject(new Error(msg.error));
      }));

      this.bus.publish<InputPromptEvent>("input.prompt", {
        sessionId,
        componentId: "grpc",
        text: prompt,
      });
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/input/
git commit -m "feat: HUD Chat and gRPC input adapters (event-driven)"
```

---

### Task 7: Migrate MCP Manager to use EventBus

**Files:**
- Create: `src/mcp/manager.ts` (copy from `src/components/mcp-manager.ts`, modify)
- Move: `src/components/mcp-oauth.ts` → `src/mcp/oauth.ts`

- [ ] **Step 1: Copy and adapt MCP Manager**

Copy `src/components/mcp-manager.ts` to `src/mcp/manager.ts`. Key changes:
- Constructor takes `EventBus` and `ToolRegistry` instead of `ToolExecutor` and `MessageQueue`
- Replace `this.toolExecutor.registerTool()` with `this.registry.register()`
- Replace `this.queue.enqueue()` notification with `this.bus.publish('core.mcp.connected', ...)`
- Register management tools (`mcp_list`, `mcp_connect`, etc.) on `ToolRegistry`

The agent implementing this task should read the existing `src/components/mcp-manager.ts` and `src/components/mcp-oauth.ts`, copy them to the new locations, and update imports/calls.

- [ ] **Step 2: Move OAuth provider**

```bash
cp src/components/mcp-oauth.ts src/mcp/oauth.ts
```

Update the import path in `src/mcp/manager.ts` from `./mcp-oauth.js` to `./oauth.js`.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/
git commit -m "feat: migrate MCP Manager to EventBus + ToolRegistry"
```

---

### Task 8: Create HTTP server and wire main.ts

**Files:**
- Create: `src/server.ts` (HTTP server — extracted from status-server)
- Rewrite: `src/main.ts`

- [ ] **Step 1: Create `src/server.ts`**

Simplified HTTP server that:
- Serves `/chat` via HudChatAdapter
- Serves `/hud` returning component state
- Serves `/logs` SSE stream
- Serves `/components/:id/:action` for component control
- Serves static files from `ui/dist/`

The agent should read `src/transport/http/status-server.ts` and extract the HTTP server, replacing the chat handler with `HudChatAdapter.handle()`.

- [ ] **Step 2: Rewrite `src/main.ts`**

New wiring:

```typescript
// src/main.ts
import { EventBus } from "./core/bus.js";
import { SessionManager } from "./core/session-manager.js";
import { JarvisCore } from "./core/jarvis.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolExecutor } from "./tools/executor.js";
import { TokenCounter } from "./output/token-counter.js";
import { McpManager } from "./mcp/manager.js";
import { GrpcInputAdapter } from "./input/grpc.js";
import { HudChatAdapter } from "./input/hud-chat.js";
import { AnthropicSessionFactory } from "./ai/anthropic/factory.js";
import { HttpServer } from "./server.js";
import { config } from "./config/index.js";
import { log } from "./logger/index.js";
import { launchHud } from "./transport/hud/electron.js";

async function main() {
  // Core
  const bus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const factory = new AnthropicSessionFactory(() => toolRegistry.getDefinitions());
  const sessions = new SessionManager(factory);

  // Core components (subscribe to bus)
  const jarvis = new JarvisCore(bus, sessions);
  const toolExecutor = new ToolExecutor(bus, toolRegistry);
  const tokenCounter = new TokenCounter(bus);

  // Register component management tools
  registerComponentTools(toolRegistry);

  // MCP
  const mcpManager = new McpManager(bus, toolRegistry);
  await mcpManager.start();

  // Input adapters
  const chatAdapter = new HudChatAdapter(bus);
  const grpcAdapter = new GrpcInputAdapter(bus);

  // HTTP server
  const server = new HttpServer(50052, chatAdapter, {
    getHudState: () => buildHudState(jarvis, toolExecutor, tokenCounter, mcpManager),
    componentControl: { /* if needed */ },
  });

  // gRPC server
  // ... wire grpcAdapter to gRPC server

  console.log("JARVIS starting...");
  console.log(`HUD  ${server.url}\n`);
  launchHud(server.url);
  console.log("JARVIS online\n");

  process.on("SIGINT", async () => {
    log.info("Shutting down...");
    jarvis.stop();
    await mcpManager.stop();
    server.stop();
    process.exit(0);
  });
}

function buildHudState(...components: any[]) {
  // Build HUD state from component getData() calls
  // Similar to current buildHudState but reads from new component locations
}

function registerComponentTools(registry: ToolRegistry) {
  // component_list, component_start, component_stop
  // These now operate on... what? We need to decide.
  // For now: simple list of known components
}

main().catch(err => {
  log.fatal({ err }, "Startup failed");
  process.exit(1);
});
```

The agent implementing this should read the current `src/main.ts`, `src/transport/http/status-server.ts`, and `src/transport/grpc/server.ts` to understand all the wiring, then rewrite using the EventBus pattern.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts src/main.ts
git commit -m "feat: wire EventBus architecture in main.ts + HTTP server"
```

---

### Task 9: Delete old files and fix imports

**Files:**
- Delete: `src/queue/`
- Delete: `src/actors/`
- Delete: `src/components/jarvis-core.ts`
- Delete: `src/components/tool-executor.ts`
- Delete: `src/components/token-counter.ts`
- Delete: `src/components/mcp-manager.ts`
- Delete: `src/components/mcp-oauth.ts`
- Delete: `src/transport/http/status-server.ts`

- [ ] **Step 1: Delete old files**

```bash
rm -rf src/queue/ src/actors/
rm src/components/jarvis-core.ts src/components/tool-executor.ts src/components/token-counter.ts
rm src/components/mcp-manager.ts src/components/mcp-oauth.ts
rm src/transport/http/status-server.ts
```

- [ ] **Step 2: Verify build**

```bash
npx tsc --noEmit
```

Fix any remaining import errors.

- [ ] **Step 3: Build UI**

```bash
cd ui && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete old queue, actors, and pre-eventbus components"
```

---

### Task 10: Smoke test

- [ ] **Step 1: Start JARVIS**

```bash
cd ~/dev/personal/jarvis-app && npm start
```

Expected: "JARVIS online", HUD opens.

- [ ] **Step 2: Test chat via HUD**

Type a message. Verify streaming works (tokens appear in real-time).

- [ ] **Step 3: Test tool use**

Ask "list components" or "connect glean". Verify tool-use loop works via events.

- [ ] **Step 4: Test gRPC**

```bash
npm run client -- localhost:50051 "hello" test1
```

Expected: response from Jarvis.

- [ ] **Step 5: Test MCP**

Ask "connect glean". Verify MCP connection and tool registration via events.

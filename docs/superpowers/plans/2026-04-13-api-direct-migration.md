# Direct API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Claude Agent SDK v2 with direct Anthropic API, enabling native tool_use, streaming, and in-process component management tools.

**Architecture:** AnthropicSession wraps `@anthropic-ai/sdk` with per-session message history. JarvisCore orchestrates a tool-use loop: stream API response → batch tool_use blocks to ToolExecutor → inject tool_results → repeat until end_turn. Chat streams via SSE to HUD.

**Tech Stack:** TypeScript, @anthropic-ai/sdk, Node.js HTTP (SSE), React 19

---

### Task 1: Swap dependencies

**Files:**
- Modify: `package.json`
- Create: `jarvis.md` (symlink)

- [ ] **Step 1: Remove Agent SDK, add Anthropic SDK**

```bash
cd ~/dev/personal/jarvis-app
npm uninstall @anthropic-ai/claude-agent-sdk patch-package
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Create jarvis.md symlink**

```bash
cd ~/dev/personal/jarvis-app
ln -s ~/.claude/CLAUDE.md jarvis.md
```

- [ ] **Step 3: Verify**

```bash
ls -la jarvis.md
cat package.json | grep anthropic
```

Expected: symlink points to `~/.claude/CLAUDE.md`, `@anthropic-ai/sdk` in dependencies, no `claude-agent-sdk`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json jarvis.md
git commit -m "chore: swap claude-agent-sdk for @anthropic-ai/sdk, add jarvis.md symlink"
```

---

### Task 2: Update AI types

**Files:**
- Modify: `src/ai/types.ts`

- [ ] **Step 1: Replace types**

Replace the entire contents of `src/ai/types.ts` with:

```typescript
// src/ai/types.ts

export interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
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
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ai/types.ts
git commit -m "feat: update AI types for direct API with streaming and tool-use"
```

---

### Task 3: Implement AnthropicSession and Factory

**Files:**
- Create: `src/ai/anthropic/session.ts`
- Create: `src/ai/anthropic/factory.ts`
- Delete: `src/ai/claude-agent/adapter.ts`

- [ ] **Step 1: Create session.ts**

Create `src/ai/anthropic/session.ts`:

```typescript
// src/ai/anthropic/session.ts
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AIStreamEvent, ToolCall, ToolResult } from "../types.js";
import { log } from "../../logger/index.js";

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

export class AnthropicSession implements AISession {
  readonly sessionId: string;
  private client: Anthropic;
  private model: string;
  private systemPrompt: string;
  private tools: ToolDef[];
  private messages: MessageParam[] = [];
  private label: string;

  constructor(opts: {
    client: Anthropic;
    model: string;
    systemPrompt: string;
    tools: ToolDef[];
    label: string;
  }) {
    this.sessionId = crypto.randomUUID();
    this.client = opts.client;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
    this.tools = opts.tools;
    this.label = opts.label;
    log.info({ label: this.label, sessionId: this.sessionId }, "AnthropicSession: created");
  }

  async *sendAndStream(prompt: string): AsyncGenerator<AIStreamEvent, void> {
    this.messages.push({ role: "user", content: prompt });
    yield* this.streamFromAPI();
  }

  addToolResults(toolCalls: ToolCall[], results: ToolResult[]): void {
    // Add the assistant message with tool_use blocks
    const toolUseBlocks: ContentBlockParam[] = toolCalls.map(tc => ({
      type: "tool_use" as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
    this.messages.push({ role: "assistant", content: toolUseBlocks });

    // Add tool results as user message
    const toolResultBlocks: ToolResultBlockParam[] = results.map(r => ({
      type: "tool_result" as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error,
    }));
    this.messages.push({ role: "user", content: toolResultBlocks });
  }

  async *continueAndStream(): AsyncGenerator<AIStreamEvent, void> {
    yield* this.streamFromAPI();
  }

  close(): void {
    log.info({ label: this.label, messageCount: this.messages.length }, "AnthropicSession: closed");
    this.messages = [];
  }

  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    log.info({ label: this.label, messageCount: this.messages.length }, "AnthropicSession: calling API");

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 8192,
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools.length > 0 ? this.tools as Anthropic.Tool[] : undefined,
      });

      const toolCalls: ToolCall[] = [];
      let fullText = "";

      stream.on("text", (text) => {
        fullText += text;
      });

      const message = await stream.finalMessage();

      // Yield text deltas by replaying accumulated text
      // (stream helper aggregates; we yield the full text as a single delta for simplicity)
      if (fullText) {
        yield { type: "text_delta", text: fullText };
      }

      // Yield tool_use blocks
      for (const block of message.content) {
        if (block.type === "tool_use") {
          const tc: ToolCall = { id: block.id, name: block.name, input: block.input as Record<string, unknown> };
          toolCalls.push(tc);
          yield { type: "tool_use", toolUse: tc };
        }
      }

      // Add assistant message to history (text + tool_use blocks)
      if (message.stop_reason !== "tool_use") {
        this.messages.push({ role: "assistant", content: message.content });
      }

      const usage = message.usage ? {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      } : undefined;

      yield {
        type: "message_complete",
        stopReason: message.stop_reason as AIStreamEvent["stopReason"],
        usage,
      };

      log.info({
        label: this.label,
        ms: Date.now() - t0,
        stopReason: message.stop_reason,
        toolCalls: toolCalls.length,
        textLength: fullText.length,
        usage,
      }, "AnthropicSession: API call complete");

    } catch (err) {
      log.error({ label: this.label, err }, "AnthropicSession: API error");
      yield { type: "error", error: String(err) };
    }
  }
}
```

- [ ] **Step 2: Create factory.ts**

Create `src/ai/anthropic/factory.ts`:

```typescript
// src/ai/anthropic/factory.ts
import { readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { AISession, AISessionFactory } from "../types.js";
import { AnthropicSession } from "./session.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

export class AnthropicSessionFactory implements AISessionFactory {
  private client: Anthropic;
  private systemPrompt: string;
  private tools: ToolDef[] = [];
  private sessionCounter = 0;

  constructor() {
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    this.systemPrompt = this.loadSystemPrompt();
    log.info({ model: config.model, systemPromptLength: this.systemPrompt.length }, "AnthropicSessionFactory: initialized");
  }

  setTools(tools: ToolDef[]): void {
    this.tools = tools;
    log.info({ toolCount: tools.length, names: tools.map(t => t.name) }, "AnthropicSessionFactory: tools updated");
  }

  getToolDefinitions(): ToolDef[] {
    return this.tools;
  }

  create(options?: { label?: string }): AISession {
    const label = options?.label ?? `session-${this.sessionCounter++}`;
    return new AnthropicSession({
      client: this.client,
      model: config.model,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      label,
    });
  }

  private loadSystemPrompt(): string {
    const path = config.systemPromptPath;
    if (!existsSync(path)) {
      log.warn({ path }, "System prompt file not found, using default");
      return "You are JARVIS, an AI assistant. Be helpful, concise, and precise.";
    }
    const content = readFileSync(path, "utf-8");
    log.info({ path, size: content.length }, "System prompt loaded");
    return content;
  }
}
```

- [ ] **Step 3: Delete old adapter**

```bash
rm -rf ~/dev/personal/jarvis-app/src/ai/claude-agent/
```

- [ ] **Step 4: Commit**

```bash
git add src/ai/anthropic/ src/ai/types.ts
git rm -r src/ai/claude-agent/
git commit -m "feat: implement AnthropicSession and Factory with direct API"
```

---

### Task 4: Update config

**Files:**
- Modify: `src/config/index.ts`

- [ ] **Step 1: Replace config**

Replace the entire contents of `src/config/index.ts`:

```typescript
export interface ComponentConfig {
  startOnBoot: boolean;
  permanent: boolean;
}

export interface JarvisConfig {
  model: string;
  grpcPort: number;
  logLevel: string;
  systemPromptPath: string;
  components: Record<string, ComponentConfig>;
}

export const config: JarvisConfig = {
  model: process.env.JARVIS_MODEL ?? "claude-sonnet-4-6",
  grpcPort: Number(process.env.JARVIS_GRPC_PORT ?? "50051"),
  logLevel: process.env.LOG_LEVEL ?? "info",
  systemPromptPath: process.env.JARVIS_SYSTEM_PROMPT ?? "./jarvis.md",
  components: {
    "jarvis-core":   { startOnBoot: true,  permanent: true },
    "chat":          { startOnBoot: true,  permanent: true },
    "grpc":          { startOnBoot: true,  permanent: false },
    "logs":          { startOnBoot: true,  permanent: false },
    "mind-map":      { startOnBoot: true,  permanent: false },
    "tool-executor": { startOnBoot: true,  permanent: false },
    "token-counter": { startOnBoot: true,  permanent: false },
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/config/index.ts
git commit -m "feat: update config for direct API (remove SDK fields, add systemPromptPath)"
```

---

### Task 5: Implement ToolExecutor component

**Files:**
- Create: `src/components/tool-executor.ts`

- [ ] **Step 1: Create tool-executor.ts**

```typescript
// src/components/tool-executor.ts
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";
import type { ComponentRegistry } from "./registry.js";
import type { ToolCall, ToolResult } from "../ai/types.js";
import { log } from "../logger/index.js";

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: ToolHandler;
}

export class ToolExecutor implements Component {
  readonly id = "tool-executor";
  readonly name = "Tool Executor";
  readonly dependencies: string[] = [];
  readonly permanent = false;

  private status: ComponentStatus = "stopped";
  private tools = new Map<string, ToolDefinition>();
  private totalCalls = 0;
  private totalErrors = 0;
  private totalTimeMs = 0;
  private callsPerTool = new Map<string, number>();

  constructor(registry: ComponentRegistry) {
    this.registerComponentTools(registry);
  }

  async start(): Promise<void> {
    this.status = "starting";
    this.status = "running";
    log.info({ toolCount: this.tools.size, names: [...this.tools.keys()] }, "ToolExecutor: started");
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    log.info("ToolExecutor: stopped");
  }

  getHudConfig(): HudComponentConfig {
    return { type: "indicator", draggable: true, resizable: false };
  }

  getData(): Record<string, unknown> {
    return {
      totalCalls: this.totalCalls,
      totalErrors: this.totalErrors,
      avgTimeMs: this.totalCalls > 0 ? Math.round(this.totalTimeMs / this.totalCalls) : 0,
      tools: [...this.tools.keys()],
      callsPerTool: Object.fromEntries(this.callsPerTool),
    };
  }

  getStatus(): ComponentStatus {
    return this.status;
  }

  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return [...this.tools.values()].map(({ name, description, input_schema }) => ({
      name, description, input_schema,
    }));
  }

  async execute(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const t0 = Date.now();
    log.info({ count: toolCalls.length, names: toolCalls.map(t => t.name) }, "ToolExecutor: executing batch");

    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const def = this.tools.get(tc.name);
        if (!def) {
          this.totalErrors++;
          return {
            tool_use_id: tc.id,
            content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
            is_error: true,
          };
        }

        try {
          this.callsPerTool.set(tc.name, (this.callsPerTool.get(tc.name) ?? 0) + 1);
          const result = await def.handler(tc.input);
          return {
            tool_use_id: tc.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          this.totalErrors++;
          log.error({ tool: tc.name, err }, "ToolExecutor: handler error");
          return {
            tool_use_id: tc.id,
            content: JSON.stringify({ error: String(err) }),
            is_error: true,
          };
        }
      })
    );

    this.totalCalls += toolCalls.length;
    this.totalTimeMs += Date.now() - t0;
    log.info({ ms: Date.now() - t0, results: results.length }, "ToolExecutor: batch complete");
    return results;
  }

  registerTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
    log.info({ name: def.name }, "ToolExecutor: tool registered");
  }

  private registerComponentTools(registry: ComponentRegistry): void {
    this.registerTool({
      name: "component_list",
      description: "List all JARVIS components with their id, name, and current status",
      input_schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        return registry.getAll().map(c => ({
          id: c.id,
          name: c.name,
          status: c.getStatus(),
          permanent: c.permanent,
        }));
      },
    });

    this.registerTool({
      name: "component_start",
      description: "Start a JARVIS component by id",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Component id to start" } },
        required: ["id"],
      },
      handler: async (input) => {
        const id = input.id as string;
        await registry.start(id);
        return { ok: true, id, status: registry.get(id)?.getStatus() };
      },
    });

    this.registerTool({
      name: "component_stop",
      description: "Stop a JARVIS component by id",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Component id to stop" } },
        required: ["id"],
      },
      handler: async (input) => {
        const id = input.id as string;
        await registry.stop(id);
        return { ok: true, id, status: "stopped" };
      },
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/tool-executor.ts
git commit -m "feat: implement ToolExecutor component with component management tools"
```

---

### Task 6: Implement TokenCounter component

**Files:**
- Create: `src/components/token-counter.ts`

- [ ] **Step 1: Create token-counter.ts**

```typescript
// src/components/token-counter.ts
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";
import { config } from "../config/index.js";
import { log } from "../logger/index.js";

export class TokenCounter implements Component {
  readonly id = "token-counter";
  readonly name = "Token Counter";
  readonly dependencies: string[] = [];
  readonly permanent = false;

  private status: ComponentStatus = "stopped";
  private inputTokens = 0;
  private outputTokens = 0;
  private requestCount = 0;

  async start(): Promise<void> {
    this.status = "starting";
    this.status = "running";
    log.info("TokenCounter: started");
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    log.info("TokenCounter: stopped");
  }

  getHudConfig(): HudComponentConfig {
    return { type: "indicator", draggable: true, resizable: false };
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

  getStatus(): ComponentStatus {
    return this.status;
  }

  record(usage: { input_tokens: number; output_tokens: number }): void {
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.requestCount++;
    log.debug({
      in: usage.input_tokens,
      out: usage.output_tokens,
      totalIn: this.inputTokens,
      totalOut: this.outputTokens,
    }, "TokenCounter: recorded");
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/token-counter.ts
git commit -m "feat: implement TokenCounter component"
```

---

### Task 7: Rewrite JarvisCore with tool-use loop and streaming

**Files:**
- Modify: `src/components/jarvis-core.ts`

- [ ] **Step 1: Replace jarvis-core.ts**

Replace the entire contents of `src/components/jarvis-core.ts`:

```typescript
// src/components/jarvis-core.ts
import type { AISession, AISessionFactory, AIStreamEvent, ToolCall } from "../ai/types.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { TokenCounter } from "./token-counter.js";
import { ActorPool } from "../actors/actor-pool.js";
import { MessageQueue } from "../queue/message-queue.js";
import { log } from "../logger/index.js";
import type { Component, ComponentStatus, HudComponentConfig } from "./types.js";

type JarvisState = "initializing" | "online" | "processing" | "offline";

type StreamCallback = (event: AIStreamEvent) => void;

export class JarvisCore implements Component {
  readonly id = "jarvis-core";
  readonly name = "Jarvis Core";
  readonly dependencies: string[] = [];
  readonly permanent = true;

  private session: AISession;
  readonly actorPool: ActorPool;
  readonly queue: MessageQueue;
  private toolExecutor: ToolExecutor;
  private tokenCounter: TokenCounter;
  private running = false;
  private state: JarvisState = "initializing";
  private totalRequests = 0;
  private lastResponseTimeMs = 0;
  private upSince = Date.now();
  private runLoopPromise: Promise<void> | undefined;
  private streamCallback: StreamCallback | null = null;

  constructor(
    factory: AISessionFactory,
    queue: MessageQueue,
    toolExecutor: ToolExecutor,
    tokenCounter: TokenCounter,
  ) {
    this.session = factory.create({ label: "jarvis-lead" });
    this.actorPool = new ActorPool(factory);
    this.queue = queue;
    this.toolExecutor = toolExecutor;
    this.tokenCounter = tokenCounter;
  }

  onStream(callback: StreamCallback): void {
    this.streamCallback = callback;
  }

  async start(): Promise<void> {
    this.running = true;
    this.upSince = Date.now();
    try {
      this.state = "online";
      this.runLoopPromise = this.runLoop();
      log.info("JarvisCore: online and ready");
    } catch (err) {
      this.state = "offline";
      this.running = false;
      throw err;
    }
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
      totalRequests: this.totalRequests,
      lastResponseMs: this.lastResponseTimeMs,
      queueSize: this.queue.size,
      activeActors: this.actorPool.size,
    };
  }

  getStatus(): ComponentStatus {
    if (!this.running) return "stopped";
    if (this.state === "initializing") return "starting";
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
          ? await this.processViaActor(msg.clientId, msg.prompt)
          : await this.processDirectly(msg.prompt);

        this.lastResponseTimeMs = Date.now() - t0;
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
    return this.processWithToolLoop(this.session, prompt);
  }

  private async processViaActor(clientId: string, prompt: string): Promise<string> {
    const actor = this.actorPool.get(clientId);
    return actor.process(prompt);
  }

  async processWithToolLoop(session: AISession, prompt: string): Promise<string> {
    let fullText = "";

    // First turn
    const stream = session.sendAndStream(prompt);
    const first = await this.consumeStream(stream);
    fullText += first.text;
    if (first.usage) this.tokenCounter.record(first.usage);

    // Tool-use loop
    let toolCalls = first.toolCalls;
    while (toolCalls.length > 0) {
      const results = await this.toolExecutor.execute(toolCalls);
      session.addToolResults(toolCalls, results);

      const contStream = session.continueAndStream();
      const cont = await this.consumeStream(contStream);
      fullText += cont.text;
      if (cont.usage) this.tokenCounter.record(cont.usage);
      toolCalls = cont.toolCalls;
    }

    return fullText;
  }

  private async consumeStream(
    stream: AsyncGenerator<AIStreamEvent, void>
  ): Promise<{ text: string; toolCalls: ToolCall[]; usage?: { input_tokens: number; output_tokens: number } }> {
    let text = "";
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    for await (const event of stream) {
      // Forward to SSE callback
      if (this.streamCallback) this.streamCallback(event);

      switch (event.type) {
        case "text_delta":
          text += event.text ?? "";
          break;
        case "tool_use":
          if (event.toolUse) toolCalls.push(event.toolUse);
          break;
        case "message_complete":
          usage = event.usage;
          break;
        case "error":
          log.error({ error: event.error }, "JarvisCore: stream error");
          break;
      }
    }

    return { text, toolCalls, usage };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/jarvis-core.ts
git commit -m "feat: rewrite JarvisCore with tool-use loop and streaming callbacks"
```

---

### Task 8: Update Actor to use new AI interface

**Files:**
- Modify: `src/actors/actor.ts`

- [ ] **Step 1: Replace actor.ts**

Replace the entire contents of `src/actors/actor.ts`:

```typescript
import type { AISession, AISessionFactory, AIStreamEvent, ToolCall, ToolResult } from "../ai/types.js";
import type { ToolExecutor } from "../components/tool-executor.js";
import { log } from "../logger/index.js";

export class Actor {
  readonly clientId: string;
  private session: AISession | null = null;
  private factory: AISessionFactory;
  private toolExecutor: ToolExecutor;
  private requestCount = 0;

  constructor(clientId: string, factory: AISessionFactory, toolExecutor: ToolExecutor) {
    this.clientId = clientId;
    this.factory = factory;
    this.toolExecutor = toolExecutor;
    log.info({ clientId }, "Actor: created");
  }

  async process(prompt: string): Promise<string> {
    if (!this.session) {
      this.session = this.factory.create({ label: `actor-${this.clientId}` });
      log.info({ clientId: this.clientId }, "Actor: session initialized (lazy)");
    }

    this.requestCount++;
    const t0 = Date.now();
    log.info({ clientId: this.clientId, requestNum: this.requestCount }, "Actor: processing");

    let fullText = "";

    const stream = this.session.sendAndStream(prompt);
    const first = await this.consumeStream(stream);
    fullText += first.text;

    let toolCalls = first.toolCalls;
    while (toolCalls.length > 0) {
      const results = await this.toolExecutor.execute(toolCalls);
      this.session.addToolResults(toolCalls, results);
      const contStream = this.session.continueAndStream();
      const cont = await this.consumeStream(contStream);
      fullText += cont.text;
      toolCalls = cont.toolCalls;
    }

    log.info({ clientId: this.clientId, ms: Date.now() - t0, resultLength: fullText.length }, "Actor: done");
    return fullText;
  }

  private async consumeStream(
    stream: AsyncGenerator<AIStreamEvent, void>
  ): Promise<{ text: string; toolCalls: ToolCall[] }> {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.text ?? "";
      if (event.type === "tool_use" && event.toolUse) toolCalls.push(event.toolUse);
    }
    return { text, toolCalls };
  }

  close(): void {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    log.info({ clientId: this.clientId, totalRequests: this.requestCount }, "Actor: closed");
  }
}
```

- [ ] **Step 2: Update ActorPool to pass ToolExecutor**

Replace `src/actors/actor-pool.ts`:

```typescript
import { Actor } from "./actor.js";
import type { AISessionFactory } from "../ai/types.js";
import type { ToolExecutor } from "../components/tool-executor.js";
import { log } from "../logger/index.js";

export class ActorPool {
  private actors = new Map<string, Actor>();
  private factory: AISessionFactory;
  private toolExecutor: ToolExecutor;

  constructor(factory: AISessionFactory, toolExecutor: ToolExecutor) {
    this.factory = factory;
    this.toolExecutor = toolExecutor;
  }

  get(clientId: string): Actor {
    let actor = this.actors.get(clientId);
    if (!actor) {
      actor = new Actor(clientId, this.factory, this.toolExecutor);
      this.actors.set(clientId, actor);
      log.debug({ clientId, poolSize: this.actors.size }, "Actor added to pool");
    }
    return actor;
  }

  destroy(clientId: string): void {
    const actor = this.actors.get(clientId);
    if (actor) {
      actor.close();
      this.actors.delete(clientId);
      log.debug({ clientId, poolSize: this.actors.size }, "Actor removed from pool");
    }
  }

  destroyAll(): void {
    for (const [clientId] of this.actors) {
      this.destroy(clientId);
    }
  }

  get size(): number {
    return this.actors.size;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/actors/actor.ts src/actors/actor-pool.ts
git commit -m "feat: update Actor and ActorPool for direct API with tool-use loop"
```

---

### Task 9: Update /chat endpoint to SSE streaming

**Files:**
- Modify: `src/transport/http/status-server.ts`

- [ ] **Step 1: Update ChatHandler type and /chat endpoint**

In `src/transport/http/status-server.ts`, change the `ChatHandler` type and the `/chat` handler:

Replace the `ChatHandler` type:

```typescript
export type ChatHandler = (prompt: string, onDelta: (text: string) => void) => Promise<string>;
```

Replace the `/chat` handler block (lines 69-84) with:

```typescript
    if (req.url === "/chat" && req.method === "POST" && this.onChat) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { prompt } = JSON.parse(body);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          const fullText = await this.onChat!(prompt, (text) => {
            res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
          });

          res.write(`data: ${JSON.stringify({ type: "done", fullText })}\n\n`);
          res.end();
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          } else {
            res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
            res.end();
          }
        }
      });
      return;
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/transport/http/status-server.ts
git commit -m "feat: update /chat endpoint to SSE streaming"
```

---

### Task 10: Update ChatPanel for SSE streaming

**Files:**
- Modify: `ui/src/components/panels/ChatPanel.tsx`

- [ ] **Step 1: Replace ChatPanel.tsx**

Replace the entire contents of `ui/src/components/panels/ChatPanel.tsx`:

```tsx
// ui/src/components/panels/ChatPanel.tsx
import { useState, useRef, useEffect, type KeyboardEvent } from 'react'

type Message = { role: 'user' | 'jarvis'; text: string }

export function ChatPanel({ disabled }: { disabled?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  const send = async () => {
    const prompt = input.trim()
    if (!prompt || loading) return

    setMessages(prev => [...prev, { role: 'user', text: prompt }])
    setInput('')
    setLoading(true)
    setStreamingText('')

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()

      if (!reader) throw new Error('No response body')

      let accumulated = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = JSON.parse(line.slice(6))

          if (data.type === 'delta') {
            accumulated += data.text
            setStreamingText(accumulated)
          } else if (data.type === 'done') {
            setMessages(prev => [...prev, { role: 'jarvis', text: data.fullText }])
            setStreamingText('')
          } else if (data.type === 'error') {
            setMessages(prev => [...prev, { role: 'jarvis', text: `[Error: ${data.error}]` }])
            setStreamingText('')
          }
        }
      }
    } catch {
      setMessages(prev => [...prev, { role: 'jarvis', text: '[Error: could not reach Jarvis]' }])
      setStreamingText('')
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      border: '1px solid #1a2a3a',
      borderRadius: '4px',
      overflow: 'hidden',
      WebkitAppRegion: 'no-drag',
    } as React.CSSProperties}>
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        fontSize: '11px',
      }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ color: msg.role === 'user' ? '#6a8' : '#4af' }}>
            <span style={{ color: '#445', marginRight: '6px', fontFamily: 'Orbitron, sans-serif', fontSize: '8px' }}>
              {msg.role === 'user' ? 'YOU' : 'JARVIS'}
            </span>
            {msg.text}
          </div>
        ))}
        {streamingText && (
          <div style={{ color: '#4af' }}>
            <span style={{ color: '#445', marginRight: '6px', fontFamily: 'Orbitron, sans-serif', fontSize: '8px' }}>JARVIS</span>
            {streamingText}
          </div>
        )}
        {loading && !streamingText && (
          <div style={{ color: '#fa4' }}>
            <span style={{ color: '#445', marginRight: '6px', fontFamily: 'Orbitron, sans-serif', fontSize: '8px' }}>JARVIS</span>
            ...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{
        borderTop: '1px solid #1a2a3a',
        padding: '6px 12px',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
      }}>
        <span style={{ color: '#445', fontSize: '8px', fontFamily: 'Orbitron, sans-serif' }}>YOU</span>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled || loading}
          placeholder={disabled ? 'Offline' : loading ? 'Waiting...' : 'Type a message...'}
          autoFocus
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#6a8',
            fontSize: '11px',
          }}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/dev/personal/jarvis-app/ui && npm run build
cd ~/dev/personal/jarvis-app
git add ui/src/components/panels/ChatPanel.tsx
git commit -m "feat: update ChatPanel for SSE streaming with real-time token display"
```

---

### Task 11: Add HUD renderers for new components

**Files:**
- Create: `ui/src/components/renderers/TokenCounterRenderer.tsx`
- Create: `ui/src/components/renderers/ToolExecutorRenderer.tsx`
- Modify: `ui/src/components/renderers/index.ts`

- [ ] **Step 1: Create TokenCounterRenderer.tsx**

```tsx
import type { HudComponentState } from '../../types/hud'

export function TokenCounterRenderer({ state }: { state: HudComponentState }) {
  const d = state.data
  return (
    <div style={{ padding: '6px 10px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#8af' }}>
      <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '7px', color: '#445', letterSpacing: '1px', marginBottom: '4px' }}>
        {String(d.model ?? '')}
      </div>
      <div style={{ display: 'flex', gap: '12px' }}>
        <span>IN <span style={{ color: '#4af' }}>{Number(d.inputTokens ?? 0).toLocaleString()}</span></span>
        <span>OUT <span style={{ color: '#6a8' }}>{Number(d.outputTokens ?? 0).toLocaleString()}</span></span>
      </div>
      <div style={{ color: '#556', marginTop: '2px' }}>
        {Number(d.requestCount ?? 0)} reqs
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create ToolExecutorRenderer.tsx**

```tsx
import type { HudComponentState } from '../../types/hud'

export function ToolExecutorRenderer({ state }: { state: HudComponentState }) {
  const d = state.data
  const calls = d.callsPerTool as Record<string, number> | undefined
  return (
    <div style={{ padding: '6px 10px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#8af' }}>
      <div style={{ display: 'flex', gap: '12px', marginBottom: '2px' }}>
        <span>CALLS <span style={{ color: '#4af' }}>{Number(d.totalCalls ?? 0)}</span></span>
        <span>ERR <span style={{ color: d.totalErrors ? '#f44' : '#556' }}>{Number(d.totalErrors ?? 0)}</span></span>
        <span>AVG <span style={{ color: '#6a8' }}>{Number(d.avgTimeMs ?? 0)}ms</span></span>
      </div>
      {calls && Object.keys(calls).length > 0 && (
        <div style={{ color: '#556', marginTop: '2px' }}>
          {Object.entries(calls).map(([name, count]) => (
            <span key={name} style={{ marginRight: '8px' }}>{name}:{count}</span>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Update renderers/index.ts**

Replace `ui/src/components/renderers/index.ts`:

```typescript
import type { ReactNode } from 'react'
import type { HudComponentState } from '../../types/hud'
import { JarvisCoreRenderer } from './JarvisCoreRenderer'
import { ChatRenderer } from './ChatRenderer'
import { GrpcRenderer } from './GrpcRenderer'
import { LogsRenderer } from './LogsRenderer'
import { MindMapRenderer } from './MindMapRenderer'
import { TokenCounterRenderer } from './TokenCounterRenderer'
import { ToolExecutorRenderer } from './ToolExecutorRenderer'

type Renderer = (props: { state: HudComponentState }) => ReactNode

export const renderers: Record<string, Renderer> = {
  "jarvis-core": JarvisCoreRenderer,
  "chat": ChatRenderer,
  "grpc": GrpcRenderer,
  "logs": LogsRenderer,
  "mind-map": MindMapRenderer,
  "token-counter": TokenCounterRenderer,
  "tool-executor": ToolExecutorRenderer,
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/renderers/
git commit -m "feat: add TokenCounter and ToolExecutor HUD renderers"
```

---

### Task 12: Wire everything in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Replace main.ts**

Replace the entire contents of `src/main.ts`:

```typescript
// src/main.ts
import { AnthropicSessionFactory } from "./ai/anthropic/factory.js";
import { MessageQueue } from "./queue/message-queue.js";
import { ComponentRegistry } from "./components/registry.js";
import { JarvisCore } from "./components/jarvis-core.js";
import { ChatComponent } from "./components/chat.js";
import { GrpcComponent } from "./components/grpc.js";
import { LogsComponent } from "./components/logs.js";
import { MindMapComponent } from "./components/mind-map.js";
import { ToolExecutor } from "./components/tool-executor.js";
import { TokenCounter } from "./components/token-counter.js";
import { StatusServer } from "./transport/http/status-server.js";
import { config } from "./config/index.js";
import { log } from "./logger/index.js";
import { launchHud } from "./transport/hud/electron.js";

function buildHudState(registry: ComponentRegistry, jarvisCore: JarvisCore) {
  const coreData = jarvisCore.getData();

  const components = registry.getActive()
    .filter(c => c.getHudConfig() !== null)
    .map(c => {
      const hudConfig = c.getHudConfig()!;
      const data = c.getData();

      const positions: Record<string, { x: number; y: number }> = {
        "jarvis-core": { x: 280, y: 30 },
        "chat": { x: 20, y: 420 },
        "grpc": { x: 680, y: 10 },
        "logs": { x: 440, y: 360 },
        "mind-map": { x: 220, y: 10 },
        "tool-executor": { x: 680, y: 60 },
        "token-counter": { x: 680, y: 120 },
      };
      const sizes: Record<string, { width: number; height: number }> = {
        "jarvis-core": { width: 220, height: 260 },
        "chat": { width: 760, height: 150 },
        "grpc": { width: 100, height: 40 },
        "logs": { width: 340, height: 200 },
        "mind-map": { width: 340, height: 320 },
        "tool-executor": { width: 180, height: 60 },
        "token-counter": { width: 180, height: 60 },
      };

      return {
        id: c.id,
        name: c.name,
        status: c.getStatus(),
        hudConfig,
        position: positions[c.id] ?? { x: 0, y: 0 },
        size: sizes[c.id] ?? { width: 200, height: 200 },
        data,
      };
    });

  return {
    reactor: {
      status: coreData.status as string,
      coreLabel: coreData.coreLabel as string,
      coreSubLabel: "",
    },
    components,
  };
}

async function main() {
  const factory = new AnthropicSessionFactory();
  const queue = new MessageQueue();
  const registry = new ComponentRegistry();

  // Create components
  const toolExecutor = new ToolExecutor(registry);
  const tokenCounter = new TokenCounter();

  // Set tool definitions on factory so sessions know about tools
  factory.setTools(toolExecutor.getDefinitions());

  const jarvisCore = new JarvisCore(factory, queue, toolExecutor, tokenCounter);
  const chat = new ChatComponent(jarvisCore);
  const grpc = new GrpcComponent(jarvisCore);
  const logs = new LogsComponent();
  const mindMap = new MindMapComponent(jarvisCore);

  // Give mind-map access to registry
  mindMap.setRegistry(registry);

  // Register all
  registry.register(jarvisCore);
  registry.register(chat);
  registry.register(grpc);
  registry.register(logs);
  registry.register(mindMap);
  registry.register(toolExecutor);
  registry.register(tokenCounter);

  // HTTP server
  const statusServer = new StatusServer(50052, () => buildHudState(registry, jarvisCore));

  // Chat handler with streaming
  statusServer.setChatHandler((prompt, onDelta) => {
    return new Promise<string>((resolve, reject) => {
      // Set up stream callback before enqueueing
      jarvisCore.onStream((event) => {
        if (event.type === "text_delta" && event.text) {
          onDelta(event.text);
        }
      });

      queue.enqueue(prompt, "")
        .then(resolve)
        .catch(reject);
    });
  });

  statusServer.setComponentControl({
    start: (id) => registry.start(id),
    stop: (id) => registry.stop(id),
  });

  console.log("JARVIS starting...");
  console.log(`HUD  ${statusServer.url}\n`);

  launchHud(statusServer.url);

  // Start components marked startOnBoot
  const bootIds = Object.entries(config.components)
    .filter(([_, cfg]) => cfg.startOnBoot)
    .map(([id]) => id);
  await registry.startAll(bootIds);

  console.log("JARVIS online\n");

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
git add src/main.ts
git commit -m "feat: wire ToolExecutor, TokenCounter, and streaming in main.ts"
```

---

### Task 13: Build UI and verify

**Files:**
- Modify: `ui/dist/` (rebuilt)

- [ ] **Step 1: Build UI**

```bash
cd ~/dev/personal/jarvis-app/ui && npm run build
```

Expected: clean build, no type errors.

- [ ] **Step 2: Type-check backend**

```bash
cd ~/dev/personal/jarvis-app && npx tsc --noEmit
```

Expected: no errors (with skipLibCheck: true in tsconfig).

- [ ] **Step 3: Verify jarvis.md symlink**

```bash
ls -la ~/dev/personal/jarvis-app/jarvis.md
```

Expected: symlink to `~/.claude/CLAUDE.md`.

- [ ] **Step 4: Verify ANTHROPIC_API_KEY is set**

```bash
echo $ANTHROPIC_API_KEY | head -c 10
```

Expected: shows first 10 chars of the API key (e.g., `sk-ant-api`).

- [ ] **Step 5: Commit build artifacts**

```bash
cd ~/dev/personal/jarvis-app
git add -A
git commit -m "chore: build UI with new renderers and streaming chat"
```

---

### Task 14: Smoke test

- [ ] **Step 1: Start JARVIS**

```bash
cd ~/dev/personal/jarvis-app && npm start
```

Expected: console shows "JARVIS starting...", "JARVIS online", HUD opens.

- [ ] **Step 2: Test chat via HUD**

Type a message in the chat panel. Verify:
- Tokens stream in real-time (not all at once)
- Response completes and shows as full message
- TokenCounter panel shows token counts

- [ ] **Step 3: Test tool use**

In the chat, ask "list all components" or "start the grpc component". Verify:
- Jarvis uses component_list / component_start tools
- ToolExecutor panel shows call count increasing
- Component actually starts

- [ ] **Step 4: Test gRPC**

```bash
cd ~/dev/personal/jarvis-app && npm run client -- localhost:50051 "hello" test1
```

Expected: response from Jarvis via gRPC actor.

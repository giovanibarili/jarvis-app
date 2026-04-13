# Multi-Provider AI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JARVIS provider-agnostic — support Anthropic and OpenAI-compatible models with runtime switching and provider-specific metrics HUDs.

**Architecture:** Introduce a `Provider` interface wrapping `AISessionFactory` + metrics HUD piece. A `ProviderRouter` manages the active provider. Each provider translates capabilities (tool definitions) to its native format. Model switching across providers resets the session.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk` (existing), `openai` npm package (new), Anthropic Messages API, OpenAI Chat Completions API.

---

### Task 1: Install OpenAI SDK

**Files:**
- Modify: `app/package.json`

- [ ] **Step 1: Install the openai package**

```bash
cd ~/dev/personal/jarvis-app/app && npm install openai
```

- [ ] **Step 2: Verify it installed**

```bash
node -e "require('openai')" && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add openai SDK dependency"
```

---

### Task 2: Create Provider interface and ProviderRouter

**Files:**
- Create: `app/src/ai/provider.ts`

- [ ] **Step 1: Create the Provider interface and ProviderRouter**

```typescript
// src/ai/provider.ts
import type { EventBus } from "../core/bus.js";
import type { AISessionFactory } from "./types.js";
import type { Piece } from "../core/piece.js";
import { log } from "../logger/index.js";

export interface Provider {
  readonly name: string;
  readonly factory: AISessionFactory;
  readonly metricsPiece: Piece;
}

type ToolDefProvider = () => Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
type ContextProvider = () => string[];
type InstructionsProvider = () => string;

export interface ProviderConfig {
  getTools: ToolDefProvider;
  getCoreContext: ContextProvider;
  getPluginContext: ContextProvider;
  getInstructions: InstructionsProvider;
}

export class ProviderRouter {
  private active: Provider | undefined;
  private bus: EventBus | undefined;
  private providerConfig: ProviderConfig;
  private providerFactories = new Map<string, (config: ProviderConfig) => Provider>();

  constructor(providerConfig: ProviderConfig) {
    this.providerConfig = providerConfig;
  }

  registerProviderFactory(name: string, factory: (config: ProviderConfig) => Provider): void {
    this.providerFactories.set(name, factory);
  }

  getActiveProvider(): Provider | undefined {
    return this.active;
  }

  getFactory(): AISessionFactory {
    if (!this.active) throw new Error("No active provider");
    return this.active.factory;
  }

  async switchTo(providerName: string, bus: EventBus): Promise<string> {
    this.bus = bus;

    const createProvider = this.providerFactories.get(providerName);
    if (!createProvider) {
      return `Unknown provider: ${providerName}. Available: ${[...this.providerFactories.keys()].join(", ")}`;
    }

    // Stop current provider's metrics HUD
    if (this.active) {
      await this.active.metricsPiece.stop();
      log.info({ from: this.active.name, to: providerName }, "ProviderRouter: switching provider");
    }

    // Create and start new provider
    this.active = createProvider(this.providerConfig);
    await this.active.metricsPiece.start(bus);
    log.info({ provider: this.active.name }, "ProviderRouter: provider active");

    return `Provider switched to ${providerName}`;
  }

  getProviderNames(): string[] {
    return [...this.providerFactories.keys()];
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add app/src/ai/provider.ts
git commit -m "feat: Provider interface and ProviderRouter for multi-provider support"
```

---

### Task 3: Extract Anthropic metrics HUD from TokenCounter

**Files:**
- Create: `app/src/ai/anthropic/metrics-hud.ts`

- [ ] **Step 1: Create AnthropicMetricsHud**

This is the current `TokenCounter` logic, moved to be Anthropic-specific:

```typescript
// src/ai/anthropic/metrics-hud.ts
import type { EventBus } from "../../core/bus.js";
import type { SystemEventMessage } from "../../core/types.js";
import type { Piece } from "../../core/piece.js";
import { config } from "../../config/index.js";
import type { AnthropicSessionFactory } from "./factory.js";
import { log } from "../../logger/index.js";

export class AnthropicMetricsHud implements Piece {
  readonly id = "anthropic-metrics";
  readonly name = "Token Counter";

  private bus!: EventBus;
  private unsub?: () => void;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheCreation = 0;
  private cacheRead = 0;
  private requestCount = 0;
  private lastRequestTokens = 0;
  private lastCacheRead = 0;
  private lastCacheCreate = 0;
  private factory: AnthropicSessionFactory;

  constructor(factory: AnthropicSessionFactory) {
    this.factory = factory;
  }

  private getMaxContext(): number {
    const model = config.model;
    if (model.includes("opus")) return 1000000;
    if (model.includes("haiku")) return 200000;
    return 200000;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.unsub = this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "api.usage") return;
      const d = msg.data;
      const reqInput = (d.input_tokens as number) ?? 0;
      const reqCacheCreate = (d.cache_creation_input_tokens as number) ?? 0;
      const reqCacheRead = (d.cache_read_input_tokens as number) ?? 0;
      this.inputTokens += reqInput;
      this.outputTokens += (d.output_tokens as number) ?? 0;
      this.cacheCreation += reqCacheCreate;
      this.cacheRead += reqCacheRead;
      this.lastRequestTokens = reqInput + reqCacheCreate + reqCacheRead;
      this.lastCacheRead = reqCacheRead;
      this.lastCacheCreate = reqCacheCreate;
      this.requestCount++;
      log.debug({
        in: d.input_tokens, out: d.output_tokens,
        cacheNew: d.cache_creation_input_tokens, cacheHit: d.cache_read_input_tokens,
      }, "AnthropicMetrics: recorded");

      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: this.getData(),
        status: "running",
      });
    });

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
        data: this.getData(),
        position: { x: 1660, y: 100 },
        size: { width: 280, height: 260 },
      },
    });

    log.info("AnthropicMetricsHud: started");
  }

  async stop(): Promise<void> {
    if (this.unsub) this.unsub();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("AnthropicMetricsHud: stopped");
  }

  getData(): Record<string, unknown> {
    const maxContext = this.getMaxContext();
    const cachePct = this.lastRequestTokens > 0 ? this.lastCacheRead / this.lastRequestTokens : 0;
    const contextPct = this.lastRequestTokens / maxContext;
    const breakdown = this.factory.getTokenBreakdown();
    const messagesEstimate = Math.max(0, this.lastRequestTokens - breakdown.systemTokens - breakdown.toolsTokens);
    return {
      model: config.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheCreation: this.cacheCreation,
      cacheRead: this.cacheRead,
      cachePct,
      contextPct,
      maxContext,
      requestCount: this.requestCount,
      systemTokens: breakdown.systemTokens,
      toolsTokens: breakdown.toolsTokens,
      messagesTokens: messagesEstimate,
    };
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add app/src/ai/anthropic/metrics-hud.ts
git commit -m "feat: extract AnthropicMetricsHud from TokenCounter"
```

---

### Task 4: Create Anthropic Provider wrapper

**Files:**
- Create: `app/src/ai/anthropic/provider.ts`

- [ ] **Step 1: Create AnthropicProvider**

```typescript
// src/ai/anthropic/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import type { Piece } from "../../core/piece.js";
import { AnthropicSessionFactory } from "./factory.js";
import { AnthropicMetricsHud } from "./metrics-hud.js";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const factory = new AnthropicSessionFactory(
    config.getTools,
    config.getCoreContext,
    config.getPluginContext,
    config.getInstructions,
  );
  const metricsPiece = new AnthropicMetricsHud(factory);

  return {
    name: "anthropic",
    factory,
    metricsPiece,
  };
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add app/src/ai/anthropic/provider.ts
git commit -m "feat: Anthropic provider wrapper with factory + metrics HUD"
```

---

### Task 5: Create OpenAI Provider (session, factory, metrics HUD)

**Files:**
- Create: `app/src/ai/openai/session.ts`
- Create: `app/src/ai/openai/factory.ts`
- Create: `app/src/ai/openai/metrics-hud.ts`
- Create: `app/src/ai/openai/provider.ts`

- [ ] **Step 1: Create OpenAISession**

```typescript
// src/ai/openai/session.ts
import OpenAI from "openai";
import type { AISession, AIStreamEvent, ToolCall, ToolResult } from "../types.js";
import { log } from "../../logger/index.js";

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
type Message = OpenAI.Chat.ChatCompletionMessageParam;

export class OpenAISession implements AISession {
  readonly sessionId: string;
  private client: OpenAI;
  private getModel: () => string;
  private getSystemPrompt: () => string;
  private getTools: () => ToolDef[];
  private messages: Message[] = [];
  private label: string;
  private abortController?: AbortController;

  constructor(opts: {
    client: OpenAI;
    model: string | (() => string);
    systemPrompt: string | (() => string);
    getTools: () => ToolDef[];
    label: string;
  }) {
    this.sessionId = crypto.randomUUID();
    this.client = opts.client;
    const model = opts.model;
    this.getModel = typeof model === "function" ? model : () => model;
    const sp = opts.systemPrompt;
    this.getSystemPrompt = typeof sp === "function" ? sp : () => sp;
    this.getTools = opts.getTools;
    this.label = opts.label;
    log.info({ label: this.label, sessionId: this.sessionId }, "OpenAISession: created");
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
      log.info({ label: this.label }, "OpenAISession: aborted");
    }
  }

  async *sendAndStream(prompt: string): AsyncGenerator<AIStreamEvent, void> {
    this.messages.push({ role: "user", content: prompt });
    yield* this.streamFromAPI();
  }

  addToolResults(toolCalls: ToolCall[], results: ToolResult[]): void {
    // Add assistant message with tool calls
    this.messages.push({
      role: "assistant",
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    });
    // Add tool results
    for (const r of results) {
      this.messages.push({
        role: "tool",
        tool_call_id: r.tool_use_id,
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      });
    }
  }

  async *continueAndStream(): AsyncGenerator<AIStreamEvent, void> {
    yield* this.streamFromAPI();
  }

  close(): void {
    log.info({ label: this.label, messageCount: this.messages.length }, "OpenAISession: closed");
    this.messages = [];
  }

  private toOpenAITools(): OpenAI.Chat.ChatCompletionTool[] {
    return this.getTools().map(t => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    this.abortController = new AbortController();

    const systemPrompt = this.getSystemPrompt();
    const tools = this.toOpenAITools();
    const model = this.getModel();

    log.info({ label: this.label, model, messageCount: this.messages.length, toolCount: tools.length }, "OpenAISession: calling API");

    try {
      const allMessages: Message[] = [
        { role: "system", content: systemPrompt },
        ...this.messages,
      ];

      const stream = await this.client.chat.completions.create({
        model,
        messages: allMessages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal: this.abortController.signal });

      const toolCalls: ToolCall[] = [];
      let fullText = "";
      let usage: { input_tokens: number; output_tokens: number } | undefined;

      // Track tool call assembly (streamed in pieces)
      const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          fullText += delta.content;
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls come in deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!pendingToolCalls.has(tc.index)) {
              pendingToolCalls.set(tc.index, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const pending = pendingToolCalls.get(tc.index)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
          }
        }

        // Usage in the final chunk
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
          };
        }
      }

      this.abortController = undefined;

      // Assemble completed tool calls
      for (const [, pending] of pendingToolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(pending.args); } catch {}
        const tc: ToolCall = { id: pending.id, name: pending.name, input };
        toolCalls.push(tc);
        yield { type: "tool_use", toolUse: tc };
      }

      // If no tool calls, save assistant message
      if (toolCalls.length === 0 && fullText) {
        this.messages.push({ role: "assistant", content: fullText });
      }

      yield {
        type: "message_complete",
        stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        usage: usage ? {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        } : undefined,
      };

      log.info({
        label: this.label,
        ms: Date.now() - t0,
        toolCalls: toolCalls.length,
        textLength: fullText.length,
        usage,
      }, "OpenAISession: API call complete");

    } catch (err) {
      this.abortController = undefined;
      if ((err as any)?.name === "AbortError") {
        log.info({ label: this.label }, "OpenAISession: stream aborted");
        yield { type: "error", error: "aborted" };
        return;
      }
      log.error({ label: this.label, err }, "OpenAISession: API error");
      yield { type: "error", error: String(err) };
    }
  }
}
```

- [ ] **Step 2: Create OpenAISessionFactory**

```typescript
// src/ai/openai/factory.ts
import OpenAI from "openai";
import type { AISession, AISessionFactory } from "../types.js";
import { OpenAISession } from "./session.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
type ToolProvider = () => ToolDef[];

export class OpenAISessionFactory implements AISessionFactory {
  private client: OpenAI;
  private getTools: ToolProvider;
  private getSystemPrompt: () => string;
  private sessionCounter = 0;

  constructor(
    getTools: ToolProvider,
    getSystemPrompt: () => string,
    clientOptions?: { apiKey?: string; baseURL?: string },
  ) {
    this.client = new OpenAI({
      apiKey: clientOptions?.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: clientOptions?.baseURL,
    });
    this.getTools = getTools;
    this.getSystemPrompt = getSystemPrompt;
    log.info({ model: config.model, baseURL: clientOptions?.baseURL ?? "default" }, "OpenAISessionFactory: initialized");
  }

  create(options?: { label?: string }): AISession {
    const label = options?.label ?? `openai-${this.sessionCounter++}`;
    return new OpenAISession({
      client: this.client,
      model: () => config.model,
      systemPrompt: this.getSystemPrompt,
      getTools: this.getTools,
      label,
    });
  }

  getToolDefinitions(): ToolDef[] {
    return this.getTools();
  }
}
```

- [ ] **Step 3: Create OpenAIMetricsHud**

```typescript
// src/ai/openai/metrics-hud.ts
import type { EventBus } from "../../core/bus.js";
import type { SystemEventMessage } from "../../core/types.js";
import type { Piece } from "../../core/piece.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

export class OpenAIMetricsHud implements Piece {
  readonly id = "openai-metrics";
  readonly name = "OpenAI Usage";

  private bus!: EventBus;
  private unsub?: () => void;
  private promptTokens = 0;
  private completionTokens = 0;
  private requestCount = 0;
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.unsub = this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "api.usage") return;
      const d = msg.data;
      const reqPrompt = (d.input_tokens as number) ?? 0;
      const reqCompletion = (d.output_tokens as number) ?? 0;
      this.promptTokens += reqPrompt;
      this.completionTokens += reqCompletion;
      this.lastPromptTokens = reqPrompt;
      this.lastCompletionTokens = reqCompletion;
      this.requestCount++;

      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: this.getData(),
        status: "running",
      });
    });

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
        data: this.getData(),
        position: { x: 1660, y: 100 },
        size: { width: 280, height: 200 },
      },
    });

    log.info("OpenAIMetricsHud: started");
  }

  async stop(): Promise<void> {
    if (this.unsub) this.unsub();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("OpenAIMetricsHud: stopped");
  }

  getData(): Record<string, unknown> {
    return {
      model: config.model,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      requestCount: this.requestCount,
      lastPrompt: this.lastPromptTokens,
      lastCompletion: this.lastCompletionTokens,
    };
  }
}
```

- [ ] **Step 4: Create OpenAI Provider wrapper**

```typescript
// src/ai/openai/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import { OpenAISessionFactory } from "./factory.js";
import { OpenAIMetricsHud } from "./metrics-hud.js";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const factory = new OpenAISessionFactory(
    config.getTools,
    () => {
      const core = config.getCoreContext().filter(Boolean);
      const plugins = config.getPluginContext().filter(Boolean);
      const instructions = config.getInstructions();
      const parts = [core.join("\n\n---\n\n"), plugins.join("\n\n---\n\n")];
      if (instructions) parts.push(instructions);
      return parts.filter(Boolean).join("\n\n---\n\n");
    },
  );
  const metricsPiece = new OpenAIMetricsHud();

  return {
    name: "openai",
    factory,
    metricsPiece,
  };
}
```

- [ ] **Step 5: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add app/src/ai/openai/
git commit -m "feat: OpenAI provider — session, factory, metrics HUD"
```

---

### Task 6: Update config and model_set for multi-provider

**Files:**
- Modify: `app/src/config/index.ts`

- [ ] **Step 1: Rewrite config with provider detection**

```typescript
// src/config/index.ts
import { load as loadSettings, save as saveSettings } from "../core/settings.js";

export interface JarvisConfig {
  model: string;
  grpcPort: number;
  grpcEnabled: boolean;
  logLevel: string;
  systemPromptPath: string;
}

const savedModel = loadSettings().model;

export const config: JarvisConfig = {
  model: process.env.JARVIS_MODEL ?? savedModel ?? "claude-sonnet-4-6",
  grpcPort: Number(process.env.JARVIS_GRPC_PORT ?? "50051"),
  grpcEnabled: process.env.JARVIS_GRPC_ENABLED !== "false",
  logLevel: process.env.LOG_LEVEL ?? "info",
  systemPromptPath: process.env.JARVIS_SYSTEM_PROMPT ?? "./jarvis-system.md",
};

const MODEL_PROVIDERS: Record<string, string> = {
  "claude-opus-4-6": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "o3": "openai",
  "o4-mini": "openai",
};

export function getProviderForModel(model: string): string {
  // Exact match first
  if (MODEL_PROVIDERS[model]) return MODEL_PROVIDERS[model];
  // Prefix match: claude-* → anthropic, gpt-*/o* → openai
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  // Default to openai-compatible (works with Ollama, Groq, etc.)
  return "openai";
}

export function setModel(model: string): { message: string; providerChanged: boolean; provider: string } {
  const oldProvider = getProviderForModel(config.model);
  const newProvider = getProviderForModel(model);
  config.model = model;
  const settings = loadSettings();
  settings.model = model;
  saveSettings(settings);
  return {
    message: `Model switched to ${model} (${newProvider}).${oldProvider !== newProvider ? " Provider changed — session will reset." : ""}`,
    providerChanged: oldProvider !== newProvider,
    provider: newProvider,
  };
}

export function getValidModels(): string[] {
  return Object.keys(MODEL_PROVIDERS);
}

export function getCurrentProvider(): string {
  return getProviderForModel(config.model);
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`
Expected: Errors in main.ts (setModel return type changed). Fixed in Task 7.

- [ ] **Step 3: Commit**

```bash
git add app/src/config/index.ts
git commit -m "feat: multi-provider config with model-to-provider mapping"
```

---

### Task 7: Rewire main.ts with ProviderRouter

**Files:**
- Modify: `app/src/main.ts`

- [ ] **Step 1: Replace factory + TokenCounter with ProviderRouter**

```typescript
// src/main.ts
import { EventBus } from "./core/bus.js";
import { SessionManager } from "./core/session-manager.js";
import { JarvisCore } from "./core/jarvis.js";
import { HudState } from "./core/hud-state.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolExecutor } from "./tools/executor.js";
import { ToolLoaderPiece } from "./tools/loader.js";
import { McpManager } from "./mcp/manager.js";
import { ChatPiece } from "./input/chat-piece.js";
import { GrpcPiece } from "./input/grpc-piece.js";
import { HttpServer } from "./server.js";
import { PieceManager } from "./core/piece-manager.js";
import { PluginManager } from "./core/plugin-manager.js";
import { CronPiece } from "./core/cron-piece.js";
import type { Piece } from "./core/piece.js";
import { log } from "./logger/index.js";
import { launchHud } from "./transport/hud/electron.js";
import { config, setModel, getValidModels, getCurrentProvider } from "./config/index.js";
import { ProviderRouter } from "./ai/provider.js";
import { createAnthropicProvider } from "./ai/anthropic/provider.js";
import { createOpenAIProvider } from "./ai/openai/provider.js";

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

  // Provider router — manages active AI provider + metrics HUD
  const providerRouter = new ProviderRouter({
    getTools: () => toolRegistry.getDefinitions(),
    getCoreContext: () => pieces.filter(p => p.id !== "plugin-manager" && p.systemContext).map(p => p.systemContext!()),
    getPluginContext: () => pieces.filter(p => p.id === "plugin-manager" && p.systemContext).map(p => p.systemContext!()),
    getInstructions: () => jarvisCore.getJarvisMd(),
  });
  providerRouter.registerProviderFactory("anthropic", createAnthropicProvider);
  providerRouter.registerProviderFactory("openai", createOpenAIProvider);

  // Activate initial provider based on current model
  await providerRouter.switchTo(getCurrentProvider(), bus);

  // SessionManager gets factory from provider router
  const sessions = new SessionManager(providerRouter.getFactory());
  jarvisCore.setSessions(sessions);

  // Model management tools — now provider-aware
  toolRegistry.register({
    name: "model_set",
    description: `Switch the AI model. Examples: claude-sonnet-4-6, claude-opus-4-6, gpt-4o, gpt-4o-mini, o3. Anthropic models use Claude, others use OpenAI-compatible API.`,
    input_schema: {
      type: "object",
      properties: { model: { type: "string", description: "Model ID to switch to" } },
      required: ["model"],
    },
    handler: async (input) => {
      const result = setModel(input.model as string);
      if (result.providerChanged) {
        await providerRouter.switchTo(result.provider, bus);
        sessions.updateFactory(providerRouter.getFactory());
        jarvisCore.abortSession("main");
      }
      return result.message;
    },
  });
  toolRegistry.register({
    name: "model_get",
    description: "Get the current AI model and provider being used.",
    input_schema: { type: "object", properties: {} },
    handler: async () => ({
      model: config.model,
      provider: getCurrentProvider(),
      available: getValidModels(),
    }),
  });

  // Cron scheduler
  pieces.push(new CronPiece(toolRegistry));

  // Plugin manager
  const pluginManager = new PluginManager(toolRegistry);
  pluginManager.setFactory(providerRouter.getFactory());
  pieces.push(pluginManager);

  const hudState = new HudState(bus);
  const pieceManager = new PieceManager(pieces, bus, toolRegistry);
  pluginManager.setPieceManager(pieceManager);

  const server = new HttpServer(50052, chatPiece, () => hudState.getState(), () => jarvisCore.abortSession("main"));
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
    const activeProvider = providerRouter.getActiveProvider();
    if (activeProvider) await activeProvider.metricsPiece.stop();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => { log.fatal({ err }, "Startup failed"); process.exit(1); });
```

- [ ] **Step 2: Add updateFactory to SessionManager**

In `app/src/core/session-manager.ts`, add a method to swap the factory (for provider switching):

```typescript
  updateFactory(factory: AISessionFactory): void {
    this.factory = factory;
    // Close all existing sessions — they use the old provider
    this.closeAll();
    log.info("SessionManager: factory updated, sessions cleared");
  }
```

- [ ] **Step 3: Remove TokenCounter import and usage**

The `TokenCounter` import and instantiation (`lines 9, 46-47` of old main.ts) are gone from the new main.ts. The file `app/src/output/token-counter.ts` can be deleted.

```bash
rm app/src/output/token-counter.ts
```

- [ ] **Step 4: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add app/src/main.ts app/src/core/session-manager.ts
git rm app/src/output/token-counter.ts
git commit -m "feat: rewire main.ts with ProviderRouter, remove TokenCounter"
```

---

### Task 8: Validate end-to-end

- [ ] **Step 1: Start JARVIS with Anthropic (default)**

```bash
cd ~/dev/personal/jarvis-app/app && npx tsx src/main.ts
```

Expected: JARVIS starts, Anthropic metrics HUD appears, normal chat works.

- [ ] **Step 2: Verify Anthropic still works**

Send "oi" via HUD. Verify response, tool bars, caching all work as before.

- [ ] **Step 3: Set OPENAI_API_KEY and test OpenAI switch**

```bash
export OPENAI_API_KEY="sk-..."
```

In the JARVIS chat, say "mude para gpt-4o". Verify:
- model_set is called
- Provider switches (Anthropic metrics HUD removed, OpenAI Usage HUD appears)
- Session resets
- Next message is processed by GPT-4o
- Tool use works (bash, read_file, etc.)

- [ ] **Step 4: Switch back to Anthropic**

Say "volte para claude-sonnet-4-6". Verify:
- Provider switches back
- Anthropic metrics HUD reappears with cache stats
- Normal operation resumes

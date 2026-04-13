# Prompt Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable prompt caching on the Anthropic API calls to reduce token costs by ~90% on stable content (tools, system prompt, core pieces).

**Architecture:** Add `cache_control: { type: "ephemeral" }` breakpoints at three positions: BP1 on the last tool definition, BP2 on the last core piece context block, BP3 on the plugin context block. The system prompt changes from a plain string to an array of `TextBlockParam` with cache breakpoints. Actor sessions (via `createWithPrompt`) remain string-based without caching.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk` (already installed), Anthropic Messages API prompt caching.

**Cache Layout:**
```
tools (schemas)                          🔒 BP1
system[0]: base prompt (jarvis-system.md)    │
system[1]: core pieces (jarvis.md, chat,     │
           grpc, tool-loader, cron, mcp) 🔒 BP2
system[2]: plugin pieces               🔒 BP3
messages
```

---

### Task 1: Update AIStreamEvent types

**Files:**
- Modify: `app/src/ai/types.ts:8`

- [ ] **Step 1: Add cache token fields to usage type**

In `app/src/ai/types.ts`, replace the `usage` field in `AIStreamEvent`:

```typescript
// Before (line 8):
usage?: { input_tokens: number; output_tokens: number };

// After:
usage?: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};
```

- [ ] **Step 2: Verify no compile errors**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`
Expected: No errors (the `as any` casts in session.ts still work with this broader type)

- [ ] **Step 3: Commit**

```bash
git add app/src/ai/types.ts
git commit -m "feat: add cache token fields to AIStreamEvent usage type"
```

---

### Task 2: Update AnthropicSessionFactory to produce cached system blocks

**Files:**
- Modify: `app/src/ai/anthropic/factory.ts`

- [ ] **Step 1: Change constructor to accept separate core/plugin context providers**

Replace the constructor and related types:

```typescript
// src/ai/anthropic/factory.ts
import { readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AISessionFactory } from "../types.js";
import { AnthropicSession } from "./session.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
type ToolProvider = () => ToolDef[];

export class AnthropicSessionFactory implements AISessionFactory {
  private client: Anthropic;
  private basePrompt: string;
  private getTools: ToolProvider;
  private getCoreContext: () => string[];
  private getPluginContext: () => string[];
  private sessionCounter = 0;

  constructor(
    getTools: ToolProvider,
    getCoreContext?: () => string[],
    getPluginContext?: () => string[],
  ) {
    this.client = new Anthropic();
    this.basePrompt = this.loadBasePrompt();
    this.getTools = getTools;
    this.getCoreContext = getCoreContext ?? (() => []);
    this.getPluginContext = getPluginContext ?? (() => []);
    log.info({ model: config.model, basePromptLength: this.basePrompt.length }, "AnthropicSessionFactory: initialized");
  }

  /** Create a session with a custom system prompt (for actors — no caching) */
  createWithPrompt(systemPrompt: string, options?: { label?: string }): AISession {
    const label = options?.label ?? `session-${this.sessionCounter++}`;
    log.debug({ label, systemPromptLength: systemPrompt.length }, "AnthropicSessionFactory: creating custom session");
    return new AnthropicSession({
      client: this.client,
      model: config.model,
      systemPrompt,
      getTools: this.getTools,
      label,
    });
  }

  getToolDefinitions(): ToolDef[] {
    return this.getTools();
  }

  /** Estimate token breakdown (1 token ≈ 4 chars) */
  getTokenBreakdown(): { systemTokens: number; toolsTokens: number } {
    const systemChars = this.buildSystemString().length;
    const toolsChars = JSON.stringify(this.getTools()).length;
    return {
      systemTokens: Math.ceil(systemChars / 4),
      toolsTokens: Math.ceil(toolsChars / 4),
    };
  }

  /** Build system prompt as TextBlockParam[] with cache breakpoints for main sessions */
  buildSystemBlocks(): TextBlockParam[] {
    const blocks: TextBlockParam[] = [];

    // Block 0: base prompt (jarvis-system.md) — always present
    blocks.push({ type: "text", text: this.basePrompt });

    // Block 1: core piece contexts — BP2 on this block
    const coreContexts = this.getCoreContext().filter(Boolean);
    if (coreContexts.length > 0) {
      blocks.push({
        type: "text",
        text: coreContexts.join("\n\n---\n\n"),
        cache_control: { type: "ephemeral" },
      });
    } else {
      // No core context — put BP2 on base prompt instead
      blocks[0].cache_control = { type: "ephemeral" };
    }

    // Block 2: plugin contexts — BP3 on this block
    const pluginContexts = this.getPluginContext().filter(Boolean);
    if (pluginContexts.length > 0) {
      blocks.push({
        type: "text",
        text: pluginContexts.join("\n\n---\n\n"),
        cache_control: { type: "ephemeral" },
      });
    }

    return blocks;
  }

  create(options?: { label?: string }): AISession {
    const label = options?.label ?? `session-${this.sessionCounter++}`;
    log.debug({ label, contextBlocks: this.getCoreContext().length + this.getPluginContext().length }, "AnthropicSessionFactory: creating session");
    return new AnthropicSession({
      client: this.client,
      model: config.model,
      systemPrompt: () => this.buildSystemBlocks(),
      getTools: this.getTools,
      label,
    });
  }

  /** String version for token estimation */
  private buildSystemString(): string {
    const core = this.getCoreContext().filter(Boolean);
    const plugins = this.getPluginContext().filter(Boolean);
    const all = [...core, ...plugins];
    if (all.length === 0) return this.basePrompt;
    return this.basePrompt + "\n\n---\n\n" + all.join("\n\n---\n\n");
  }

  private loadBasePrompt(): string {
    const path = config.systemPromptPath;
    if (!existsSync(path)) {
      log.warn({ path }, "System prompt file not found, using default");
      return "You are JARVIS, an AI assistant created by Mr. Stark. Be helpful, concise, and precise. Address the user as Sir.";
    }
    const content = readFileSync(path, "utf-8");
    log.info({ path, size: content.length }, "System prompt loaded");
    return content;
  }
}
```

- [ ] **Step 2: Verify no compile errors**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`
Expected: Errors in session.ts (expected — it still expects string), errors in main.ts (constructor signature changed). These are fixed in Tasks 3 and 4.

---

### Task 3: Update AnthropicSession to support TextBlockParam[] and tool caching

**Files:**
- Modify: `app/src/ai/anthropic/session.ts`

- [ ] **Step 1: Update constructor and getSystemPrompt type**

In `app/src/ai/anthropic/session.ts`, update the imports, type of `getSystemPrompt`, and the constructor:

```typescript
// src/ai/anthropic/session.ts
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AIStreamEvent, ToolCall, ToolResult } from "../types.js";
import { log } from "../../logger/index.js";

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
type SystemPrompt = string | TextBlockParam[];

export class AnthropicSession implements AISession {
  readonly sessionId: string;
  private client: Anthropic;
  private model: string;
  private getSystemPrompt: () => SystemPrompt;
  private getTools: () => ToolDef[];
  private messages: MessageParam[] = [];
  private label: string;

  constructor(opts: {
    client: Anthropic;
    model: string;
    systemPrompt: string | (() => SystemPrompt);
    getTools: () => ToolDef[];
    label: string;
  }) {
    this.sessionId = crypto.randomUUID();
    this.client = opts.client;
    this.model = opts.model;
    this.getSystemPrompt = typeof opts.systemPrompt === "function" ? opts.systemPrompt : () => opts.systemPrompt;
    this.getTools = opts.getTools;
    this.label = opts.label;
    log.info({ label: this.label, sessionId: this.sessionId }, "AnthropicSession: created");
  }
```

No changes to `sendAndStream`, `addToolResults`, `continueAndStream`, or `close`.

- [ ] **Step 2: Update streamFromAPI to add cache_control to tools and use typed usage**

Replace the `streamFromAPI` method:

```typescript
  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    const rawTools = this.getTools();
    const toolNames = rawTools.map((t: any) => t.name);

    // Debug: log full message history structure
    const msgSummary = this.messages.map((m, i) => {
      const role = m.role;
      if (typeof m.content === "string") return { i, role, type: "text", length: m.content.length };
      if (Array.isArray(m.content)) return { i, role, blocks: m.content.map((b: any) => ({ type: b.type, ...(b.type === "tool_use" ? { name: b.name } : {}), ...(b.type === "tool_result" ? { tool_use_id: b.tool_use_id, contentType: typeof b.content === "string" ? "string" : Array.isArray(b.content) ? `array[${b.content.length}]` : typeof b.content } : {}) })) };
      return { i, role };
    });
    log.info({ label: this.label, messageCount: this.messages.length, toolCount: toolNames.length, tools: toolNames, messages: msgSummary }, "AnthropicSession: calling API");

    try {
      // Add cache_control (BP1) to the last tool definition
      const tools: Anthropic.Tool[] | undefined = rawTools.length > 0
        ? rawTools.map((t, i) => ({
            ...t,
            ...(i === rawTools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
          })) as Anthropic.Tool[]
        : undefined;

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 8192,
        system: this.getSystemPrompt(),
        messages: this.messages,
        tools,
      });

      const toolCalls: ToolCall[] = [];
      let fullText = "";

      stream.on("text", (text) => {
        fullText += text;
      });

      const message = await stream.finalMessage();

      if (fullText) {
        yield { type: "text_delta", text: fullText };
      }

      for (const block of message.content) {
        if (block.type === "tool_use") {
          const tc: ToolCall = { id: block.id, name: block.name, input: block.input as Record<string, unknown> };
          toolCalls.push(tc);
          yield { type: "tool_use", toolUse: tc };
        }
      }

      if (message.stop_reason !== "tool_use") {
        this.messages.push({ role: "assistant", content: message.content });
      }

      const usage = message.usage ? {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: (message.usage as any).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: (message.usage as any).cache_read_input_tokens ?? 0,
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
        toolCallNames: toolCalls.map(tc => tc.name),
        textLength: fullText.length,
        textPreview: fullText.slice(0, 300),
        usage,
      }, "AnthropicSession: API call complete");

    } catch (err) {
      log.error({ label: this.label, err }, "AnthropicSession: API error");
      yield { type: "error", error: String(err) };
    }
  }
```

- [ ] **Step 3: Verify no compile errors**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`
Expected: Errors only in main.ts (factory constructor signature). Fixed in Task 4.

- [ ] **Step 4: Commit**

```bash
git add app/src/ai/anthropic/session.ts
git commit -m "feat: support TextBlockParam[] system prompt and tool cache_control in session"
```

---

### Task 4: Update main.ts to pass separate core/plugin context

**Files:**
- Modify: `app/src/main.ts:38-41`

- [ ] **Step 1: Split the context provider into core and plugin callbacks**

Replace lines 38-41 in `app/src/main.ts`:

```typescript
// Before:
const factory = new AnthropicSessionFactory(
  () => toolRegistry.getDefinitions(),
  () => pieces.filter(p => p.systemContext).map(p => p.systemContext!()),
);

// After:
const factory = new AnthropicSessionFactory(
  () => toolRegistry.getDefinitions(),
  () => pieces.filter(p => p.id !== "plugin-manager" && p.systemContext).map(p => p.systemContext!()),
  () => pieces.filter(p => p.id === "plugin-manager" && p.systemContext).map(p => p.systemContext!()),
);
```

- [ ] **Step 2: Verify full compile**

Run: `cd ~/dev/personal/jarvis-app/app && npx tsc --noEmit`
Expected: No errors. All types align.

- [ ] **Step 3: Commit**

```bash
git add app/src/main.ts app/src/ai/anthropic/factory.ts app/src/ai/types.ts
git commit -m "feat: enable prompt caching with 3 breakpoints (tools, core, plugins)"
```

---

### Task 5: Validate prompt caching in running JARVIS

- [ ] **Step 1: Start JARVIS**

```bash
cd ~/dev/personal/jarvis-app/app && npx tsx src/main.ts
```

Expected: JARVIS starts without errors. Log shows `AnthropicSessionFactory: initialized`.

- [ ] **Step 2: Send first prompt**

Send a message via the HUD chat. Check the logs for the API call response.

Expected in logs (`AnthropicSession: API call complete`):
```
usage: {
  input_tokens: <some number>,
  output_tokens: <some number>,
  cache_creation_input_tokens: <non-zero — cache being written>,
  cache_read_input_tokens: 0
}
```

The first request writes to cache. `cache_creation_input_tokens` should be > 0 (the cached tools + system tokens). `cache_read_input_tokens` should be 0.

- [ ] **Step 3: Send second prompt within 5 minutes**

Send another message via the HUD chat.

Expected in logs:
```
usage: {
  input_tokens: <small number — just the new message>,
  output_tokens: <some number>,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: <non-zero — cache hit!>
}
```

The second request reads from cache. `cache_read_input_tokens` should be > 0 (matching approximately what was created in step 2). `cache_creation_input_tokens` should be 0.

- [ ] **Step 4: Verify via TokenCounter HUD**

Check the HUD token display. The cache hit/miss ratio should show cache reads on the second+ requests.

- [ ] **Step 5: Send a third prompt to confirm consistent caching**

Send a third message. Verify `cache_read_input_tokens` is consistently > 0.

**If `cache_read_input_tokens` is 0 on repeat requests, check:**
1. Is the system prompt deterministic? (jarvis.md re-reads from disk — content must not change between requests)
2. Are tools in stable order? (`ToolRegistry` uses a Map — insertion order is preserved in JS Maps, so this should be fine)
3. Is the total cached prefix >= 2048 tokens? (Sonnet 4.6 minimum). Check the log for `cache_creation_input_tokens` on first request — if 0, prefix is too short.

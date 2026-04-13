# JARVIS — Direct API Migration Design

**Date:** 2026-04-13
**Status:** Draft
**Codename:** JARVIS

## Summary

Replace the Claude Agent SDK v2 (`unstable_v2_createSession`) with direct Anthropic API usage (`@anthropic-ai/sdk`). This gives full control over tool definitions, enables native `tool_use` blocks, real-time streaming to the HUD chat, and prepares the architecture for future MCP server integration.

## Motivation

The Agent SDK v2 session does not support custom tool definitions (GitHub issue #176). This prevents Jarvis from exposing in-process capabilities (component management) as formal tools to the LLM. The direct API provides native tool_use support, streaming control, and system prompt management without SDK constraints.

## Architecture

### High-Level Flow

```
User prompt (CLI/gRPC/HUD)
  → MessageQueue
  → JarvisCore (orchestrator)
  → Anthropic API (messages.create with tools + streaming)
  → Stream events:
      text_delta  → SSE to HUD ChatPanel
      tool_use    → batch to ToolExecutor component
      end_turn    → final result
  → ToolExecutor runs Promise.all(handlers)
  → tool_results back to JarvisCore
  → JarvisCore sends tool_results to API (loop continues)
  → end_turn → response complete
```

### Components

#### 1. AnthropicSession (replaces ClaudeAgentSession)

**File:** `src/ai/anthropic/session.ts`

Wraps `@anthropic-ai/sdk` client. Manages conversation history (messages array) per session instance. Receives tool definitions and system prompt at construction.

```typescript
interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error';
  // text_delta: partial text token
  text?: string;
  // tool_use: one block from the response
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  // message_complete: final assembled message + stop_reason
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  message?: AssistantMessage;
  // usage
  usage?: { input_tokens: number; output_tokens: number };
}

interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string): AsyncGenerator<AIStreamEvent, void>;
  addToolResults(results: ToolResult[]): void;
  continueAndStream(): AsyncGenerator<AIStreamEvent, void>;
  close(): void;
}
```

Key behaviors:
- `sendAndStream(prompt)` — appends user message to history, calls `messages.stream()`, yields events. Does NOT auto-loop on tool_use — caller decides.
- `addToolResults(results)` — appends the assistant message (with tool_use blocks) and tool_result messages to history.
- `continueAndStream()` — calls API again with accumulated history, yields events. Used after tool results.
- System prompt loaded from `jarvis.md` once at construction.
- History grows unbounded (optimization deferred).

#### 2. AnthropicSessionFactory (replaces ClaudeAgentSessionFactory)

**File:** `src/ai/anthropic/factory.ts`

Creates AnthropicSession instances. Holds shared config: model, API key (from env), system prompt content, tool definitions.

```typescript
interface AISessionFactory {
  create(options?: { label?: string }): AISession;
}
```

The factory reads `jarvis.md` once and shares the content across all sessions. Tool definitions come from the ToolExecutor's registry.

#### 3. ToolExecutor Component

**File:** `src/components/tool-executor.ts`

A Component registered in the ComponentRegistry. Owns the tool handler registry and executes tool calls in batch.

```typescript
type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: ToolHandler;
}
```

Responsibilities:
- Maintains a map of `name → ToolDefinition`
- `execute(toolCalls: ToolCall[])` — runs all handlers via `Promise.all`, returns results array
- Exposes tool definitions (without handlers) for the API call
- HUD data: total calls, calls per tool, average execution time, errors

Initial tools:
- `component_list` — returns all components with id, name, status
- `component_start` — starts a component by id, returns success/error
- `component_stop` — stops a component by id, returns success/error

All three operate directly on the ComponentRegistry reference (in-process, no HTTP).

Dependencies: no component dependencies. Receives a ComponentRegistry reference at construction (injected in main.ts).

#### 4. TokenCounter Component

**File:** `src/components/token-counter.ts`

A Component that accumulates token usage from API responses.

```typescript
getData(): {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}
```

JarvisCore calls `tokenCounter.record(usage)` after each API response. The component exposes data for a HUD panel showing running totals.

No dependencies. Starts on boot. Permanent: false (informational).

#### 5. JarvisCore Changes

The `processDirectly()` method becomes a tool-use loop:

```typescript
private async processDirectly(prompt: string): Promise<string> {
  let fullText = '';

  // First turn
  const stream = this.session.sendAndStream(prompt);
  const { text, toolCalls, usage } = await this.consumeStream(stream);
  fullText += text;
  this.tokenCounter.record(usage);

  // Tool-use loop
  while (toolCalls.length > 0) {
    const results = await this.toolExecutor.execute(toolCalls);
    this.session.addToolResults(results);

    const contStream = this.session.continueAndStream();
    const cont = await this.consumeStream(contStream);
    fullText += cont.text;
    this.tokenCounter.record(cont.usage);
    toolCalls = cont.toolCalls;
  }

  return fullText;
}
```

`consumeStream()` iterates the AsyncGenerator, emits text_delta events to the SSE chat stream, collects tool_use blocks, and returns the aggregated result.

Actor.process() follows the same pattern — actors share the same tool-use loop logic. All sessions (lead + actors) have access to the same tool definitions and ToolExecutor instance.

#### 6. Chat Streaming (SSE)

The `/chat` endpoint changes from POST→JSON to POST→SSE:

- Client sends POST with `{ prompt }` body
- Server responds with `Content-Type: text/event-stream`
- Events: `data: { type: "delta", text: "..." }` for tokens, `data: { type: "done", fullText: "..." }` at end
- ChatPanel.tsx switches from fetch→JSON to fetch with streaming response body reader

#### 7. System Prompt

`jarvis.md` at project root — symlink to `~/.claude/CLAUDE.md` initially. Read once by the factory, passed as `system` parameter to every API call. No conversation turn wasted on bootstrap.

The bootstrap() method in JarvisCore is removed entirely. The system prompt handles initialization.

### Dependency Graph (updated)

```
jarvis-core: no component dependencies
  (but receives: toolExecutor ref, tokenCounter ref, chatStream callback)
chat: depends on jarvis-core
grpc: depends on jarvis-core
mind-map: depends on jarvis-core
logs: no dependencies
tool-executor: no component dependencies (receives registry ref)
token-counter: no dependencies
```

### Config Changes

```typescript
interface JarvisConfig {
  model: string;           // "claude-sonnet-4-6" | "claude-opus-4-6"
  grpcPort: number;
  logLevel: string;
  systemPromptPath: string; // default: "./jarvis.md"
  components: Record<string, ComponentConfig>;
  // removed: allowedTools, permissionMode (Agent SDK concepts)
}
```

API key from `ANTHROPIC_API_KEY` env var (standard for @anthropic-ai/sdk).

### Dependencies

**Add:** `@anthropic-ai/sdk` (latest)
**Remove:** `@anthropic-ai/claude-agent-sdk`, `patch-package`

### Files Changed

| Action | File | Description |
|--------|------|-------------|
| Delete | `src/ai/claude-agent/adapter.ts` | Agent SDK adapter |
| Create | `src/ai/anthropic/session.ts` | Direct API session with streaming |
| Create | `src/ai/anthropic/factory.ts` | Session factory |
| Modify | `src/ai/types.ts` | New AIStreamEvent, updated AISession interface |
| Create | `src/components/tool-executor.ts` | Tool execution component |
| Create | `src/components/token-counter.ts` | Token usage tracking |
| Modify | `src/components/jarvis-core.ts` | Tool-use loop, remove bootstrap, streaming |
| Modify | `src/actors/actor.ts` | Use new streaming interface |
| Modify | `src/transport/http/status-server.ts` | /chat as SSE |
| Modify | `ui/src/components/panels/ChatPanel.tsx` | SSE streaming consumption |
| Create | `ui/src/components/renderers/TokenCounterRenderer.tsx` | Token HUD panel |
| Create | `ui/src/components/renderers/ToolExecutorRenderer.tsx` | Tool execution HUD panel |
| Modify | `ui/src/components/renderers/index.ts` | Register new renderers |
| Modify | `src/config/index.ts` | Remove SDK fields, add systemPromptPath |
| Modify | `src/main.ts` | Wire new components, pass refs |
| Modify | `package.json` | Swap SDK deps |
| Create | `jarvis.md` | Symlink to ~/.claude/CLAUDE.md |

### What's NOT in Scope

- MCP client integration (prepared via ToolHandler interface, not connected)
- Message history truncation/summarization
- Multiple model support per session
- Voice/TTS
- Authentication/multi-user

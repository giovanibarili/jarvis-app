# JARVIS — EventBus + Hexagonal Architecture Design

**Date:** 2026-04-13
**Status:** Draft
**Codename:** JARVIS

## Summary

Replace the MessageQueue + direct method calls with a centralized EventBus. Restructure the app using hexagonal architecture: core (Jarvis) defines ports, adapters implement them via bus events. Messages carry `sessionId` (shared conversation context) and `componentId` (origin). JarvisCore becomes a state machine that reacts to events instead of polling a queue.

## Motivation

The current architecture has tight coupling: JarvisCore polls a queue, calls ToolExecutor directly, uses callbacks for streaming, and resolves Promises to return results. Components can't observe each other's activity without being wired explicitly. Adding a new input adapter (e.g., WebSocket) or viewer (e.g., mobile HUD) requires modifying main.ts wiring.

With an EventBus, components are fully decoupled. Input adapters publish, core processes, viewers consume. Adding a new adapter is one file with subscribe/publish calls — no wiring changes.

## Architecture

### BusMessage — Base Type

Every message on the bus carries:

```typescript
interface BusMessage {
  id: string            // unique event ID
  timestamp: number     // Date.now()
  sessionId: string     // conversation context (shared)
  componentId: string   // who published this
}
```

Concrete events extend BusMessage with topic-specific fields.

### EventBus Interface

```typescript
interface EventBus {
  publish<T extends BusMessage>(topic: string, data: Omit<T, 'id' | 'timestamp' | 'topic'>): void
  subscribe<T extends BusMessage>(topic: string, handler: (msg: T) => void | Promise<void>): () => void
  subscribePattern<T extends BusMessage>(pattern: string, handler: (msg: T) => void | Promise<void>): () => void
}
```

`subscribePattern` supports wildcards: `core.*.stream.delta` matches all sessions.

### Topics

```
input.prompt                         — new prompt from any adapter
core.{sessionId}.stream.delta        — streaming token
core.{sessionId}.stream.complete     — response finished
core.{sessionId}.tool.request        — tool execution needed
core.{sessionId}.tool.result         — tool execution done
core.{sessionId}.error               — processing error
core.mcp.connected                   — MCP server connected
core.mcp.disconnected                — MCP server disconnected
core.mcp.auth_required               — MCP server needs auth
core.component.started               — component lifecycle
core.component.stopped               — component lifecycle
core.api.usage                       — token consumption
```

### Event Types

```typescript
// Input
interface InputPromptEvent extends BusMessage {
  text: string
  replyTopic?: string   // optional: for request/response patterns
}

// Core streaming
interface StreamDeltaEvent extends BusMessage {
  text: string
}

interface StreamCompleteEvent extends BusMessage {
  fullText: string
  usage: { input_tokens: number; output_tokens: number }
}

// Tools
interface ToolRequestEvent extends BusMessage {
  calls: ToolCall[]
}

interface ToolResultEvent extends BusMessage {
  results: ToolResult[]
}

// MCP
interface McpConnectedEvent extends BusMessage {
  server: string
  tools: string[]
}

// API usage
interface ApiUsageEvent extends BusMessage {
  input_tokens: number
  output_tokens: number
  model: string
}
```

### JarvisCore — State Machine

```
States: IDLE | PROCESSING | WAITING_TOOLS

IDLE:
  on input.prompt → start API call → PROCESSING

PROCESSING:
  streaming deltas → publish core.{sessionId}.stream.delta
  on stop_reason: end_turn → publish stream.complete → IDLE
  on stop_reason: tool_use → publish tool.request → WAITING_TOOLS

WAITING_TOOLS:
  on core.{sessionId}.tool.result → addToolResults → continue API → PROCESSING
```

No polling loop. No queue. Pure event reactions.

### Flow — Chat Message

```
1. HUD Chat adapter publishes:
   topic: input.prompt
   data: { sessionId: "main", componentId: "hud-chat", text: "conecta o glean" }

2. JarvisCore subscribed to input.prompt:
   - Gets/creates session for sessionId "main"
   - Calls API with streaming
   - For each text delta: publish core.main.stream.delta
   - On tool_use: publish core.main.tool.request

3. HUD Chat subscribed to core.main.stream.delta:
   - Renders tokens in real-time

4. ToolExecutor subscribed to core.*.tool.request:
   - Executes tools in parallel
   - Publishes core.main.tool.result

5. JarvisCore subscribed to core.main.tool.result:
   - Adds results to session
   - Continues API call (back to step 2)

6. On end_turn: JarvisCore publishes core.main.stream.complete
   - HUD Chat shows final message
   - TokenCounter records usage
   - gRPC (if subscribed to same session) gets the result too
```

### Session Management

Sessions are created on demand by JarvisCore when it receives an `input.prompt` with a new `sessionId`. Each session has:
- An AISession (Anthropic API wrapper with message history)
- A state (IDLE / PROCESSING / WAITING_TOOLS)
- Tool definitions from ToolExecutor

Multiple adapters can share a session by using the same `sessionId`. The default session is `"main"`.

### Component Mapping

| Old | New | Role |
|-----|-----|------|
| MessageQueue | EventBus | Communication layer |
| JarvisCore.runLoop() | JarvisCore state machine | Core processing |
| JarvisCore.onStream(callback) | bus.publish('core.*.stream.delta') | Streaming |
| queue.enqueue() + resolve() | publish input.prompt + subscribe stream.complete | Request/response |
| ToolExecutor.execute() (direct call) | core.*.tool.request → core.*.tool.result | Tool execution |
| TokenCounter.record() (direct call) | subscribe core.api.usage | Metrics |
| McpManager queue.enqueue() (notify) | publish core.mcp.connected | Notifications |
| ActorPool | Session map in JarvisCore | Multi-session |
| StatusServer.setChatHandler() | Input adapter subscribing to bus | HTTP input |

### Directory Structure

```
src/
  core/
    bus.ts              — EventBus implementation
    types.ts            — BusMessage and all event types
    jarvis.ts           — JarvisCore state machine
    session-manager.ts  — Creates/manages AI sessions per sessionId
  
  tools/
    executor.ts         — subscribes core.*.tool.request, publishes tool.result
    registry.ts         — tool definitions store
  
  input/
    hud-chat.ts         — HTTP SSE: publishes input.prompt, subscribes core.*.stream.*
    grpc.ts             — gRPC: publishes input.prompt, subscribes core.*.stream.complete
  
  output/
    token-counter.ts    — subscribes core.api.usage
    hud-state.ts        — subscribes core.component.* for HUD panel data
  
  mcp/
    manager.ts          — MCP client, publishes core.mcp.*
    oauth.ts            — OAuth provider
  
  ai/
    types.ts            — AISession, AIStreamEvent
    anthropic.ts        — Anthropic API adapter
  
  config/index.ts
  logger/index.ts
  main.ts              — creates bus, creates components, wires subscribers

ui/src/
  (unchanged — renderers consume HUD state via /hud endpoint)
```

### What Gets Deleted

- `src/queue/` (MessageQueue, QueueMessage type)
- `src/actors/` (ActorPool, Actor — replaced by session map)
- `src/components/chat.ts` (already deleted)
- `src/components/logs.ts` (already deleted)
- `src/transport/cli/repl.ts` (already deleted)

### What Gets Rewritten

- `src/components/jarvis-core.ts` → `src/core/jarvis.ts` (state machine)
- `src/components/tool-executor.ts` → `src/tools/executor.ts` (event-driven)
- `src/components/token-counter.ts` → `src/output/token-counter.ts` (subscriber)
- `src/components/mcp-manager.ts` → `src/mcp/manager.ts` (event-driven)
- `src/transport/http/status-server.ts` → `src/input/hud-chat.ts` (adapter)
- `src/transport/grpc/server.ts` → `src/input/grpc.ts` (adapter)
- `src/main.ts` (new wiring)

### What Stays

- `src/ai/anthropic/session.ts` and `factory.ts` (LLM adapter — unchanged)
- `src/components/types.ts` and `registry.ts` (component lifecycle)
- `src/components/mind-map.ts`, `grpc.ts` (component wrappers)
- `src/transport/hud/electron.ts` (Electron launcher)
- `src/logger/index.ts` (logging)
- `src/config/index.ts` (config)
- `ui/src/` (HUD frontend — unchanged)

### NOT in Scope

- Actor model / mailbox (future evolution)
- Event persistence / replay
- Event schema validation
- Distributed bus

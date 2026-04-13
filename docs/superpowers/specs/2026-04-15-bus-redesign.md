# EventBus Redesign — Typed Channels with Source/Target

**Date:** 2026-04-15
**Status:** Draft
**Project:** JARVIS

## Goal

Replace the flat topic-string EventBus with typed channels that carry source, target, and semantic intent. Eliminate ambiguity about who sent a message, who should receive it, and whether it should be processed or displayed.

## Problems Solved

1. `input.prompt` serves as both "process this" and "display this" — no way to distinguish
2. Actor streams pollute main chat via wildcard subscriptions
3. Messages lack author identity — chat shows everything as "JARVIS"
4. Plugins hack existing topics to communicate, creating fragile conventions

## Channels

6 typed channels. No mention of specific plugins — channels are generic by function.

| Channel | Purpose | Payload |
|---------|---------|---------|
| `ai.request` | Someone wants an AI session to process a prompt | text, replyTo? |
| `ai.stream` | Tokens coming from any AI session | event (delta/complete/error), text, usage |
| `tool.request` | AI session wants to execute tools | calls[] |
| `tool.result` | Tool execution results | results[] |
| `hud.update` | Panel lifecycle | action (add/update/remove), piece data |
| `system.event` | Everything else | event name, data |

## Message Structure

Every message carries source and target:

```typescript
interface BusMessage {
  id: string;
  timestamp: number;
  source: string;
  target?: string;
  channel: Channel;
}
```

`source` identifies who sent the message: "jarvis-core", "user", "alice", "voice", "grpc-client1".

`target` identifies who should receive it: "main" (main chat session), "actor-alice", "grpc-123", or undefined for broadcast.

## Channel-Specific Message Types

```typescript
type Channel = "ai.request" | "ai.stream" | "tool.request" | "tool.result" | "hud.update" | "system.event";

interface AIRequestMessage extends BusMessage {
  channel: "ai.request";
  text: string;
  replyTo?: string;
}

interface AIStreamMessage extends BusMessage {
  channel: "ai.stream";
  event: "delta" | "complete" | "error";
  text?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

interface ToolRequestMessage extends BusMessage {
  channel: "tool.request";
  calls: ToolCall[];
}

interface ToolResultMessage extends BusMessage {
  channel: "tool.result";
  results: ToolResult[];
}

interface HudUpdateMessage extends BusMessage {
  channel: "hud.update";
  action: "add" | "update" | "remove";
  piece: HudPieceData;
}

interface SystemEventMessage extends BusMessage {
  channel: "system.event";
  event: string;
  data: Record<string, unknown>;
}
```

## Bus API

```typescript
class EventBus {
  publish<T extends BusMessage>(msg: Omit<T, "id" | "timestamp">): void;
  subscribe<T extends BusMessage>(channel: Channel, handler: (msg: T) => void): () => void;
}
```

No more topic strings. No more pattern matching. Subscribe to a channel, filter by source/target in the handler.

## Piece → Channel Mapping

**JarvisCore**
- Subscribes: `ai.request` (filter: target=main or target=grpc-*)
- Publishes: `ai.stream` (source=jarvis-core, target=session), `tool.request`, `system.event` (api.usage)

**ChatPiece**
- Publishes: `ai.request` (source=user, target=main)
- Subscribes: `ai.stream` (filter: target=main), `ai.request` (filter: target=main, for displaying user messages)

**GrpcPiece**
- Publishes: `ai.request` (source=grpc, target=grpc-{id})
- Subscribes: `ai.stream` (filter: target=grpc-{id})

**ToolExecutor**
- Subscribes: `tool.request`
- Publishes: `tool.result`

**TokenCounter**
- Subscribes: `system.event` (filter: event=api.usage)

**HudState**
- Subscribes: `hud.update`

**All pieces**
- Publish: `hud.update` (source=pieceId, action=add/update/remove)

## Plugin: Voice

**VoicePiece**
- Subscribes: `ai.stream` (filter: target=main, event=complete) → generates TTS
- Publishes: `system.event` (source=voice, event=tts.health)
- Publishes: `hud.update`

## Plugin: Actors

**ActorPoolPiece**
- Publishes: `ai.request` (source=jarvis-core, target=actor-{name}) via actor_dispatch tool
- Subscribes: `ai.stream` (filter: source=actor name, event=complete, target=main) to know task finished
- Publishes: `ai.stream` (source=actorName, target=main, event=complete) to show result in main chat
- Publishes: `hud.update`
- Registers tools: actor_dispatch, actor_list, actor_kill, bus_publish

**ActorRunnerPiece**
- Subscribes: `ai.request` (filter: target starts with "actor-")
- Publishes: `ai.stream` (source=actorName, target=actor-{name}) during execution
- Publishes: `ai.stream` (source=actorName, target=main, event=complete) when done
- Uses ctx.toolRegistry.execute() for tool calls (direct, not via bus)

**ActorChatPiece**
- Publishes: `ai.request` (source=user, target=actor-{name}) for direct messages
- Subscribes: `ai.request` (filter: target=actor-*) to capture dispatches in history
- Subscribes: `ai.stream` (filter: target=actor-*) for SSE streaming
- Registers HTTP routes for actor chat

## Actor Tools

Tools remain the primary interface for the AI to manage actors. The AI does not need to understand bus channels.

- `actor_dispatch(name, role, task)` — handler publishes ai.request with target=actor-{name}
- `actor_list()` — returns pool state
- `actor_kill(name)` — stops actor, cleans up
- `bus_publish(channel, source, target, data)` — advanced: publish raw message to any channel

The ActorPoolPiece systemContext instructs the AI about tools and mentions bus_publish as an advanced option for direct communication.

## Migration

All pieces and plugins need to be updated. The old topic-string API is removed entirely. Since the codebase is small and we control all plugins, this is a clean break.

Files to modify in jarvis-app:
- `packages/core/src/bus.ts` — new API
- `packages/core/src/types.ts` — new message types
- `app/src/core/jarvis.ts` — new channels
- `app/src/core/hud-state.ts` — subscribe to hud.update
- `app/src/input/chat-piece.ts` — ai.request + ai.stream
- `app/src/input/grpc-piece.ts` — ai.request + ai.stream
- `app/src/input/grpc.ts` — ai.request + ai.stream
- `app/src/tools/executor.ts` — tool.request + tool.result
- `app/src/output/token-counter.ts` — system.event
- `app/src/mcp/manager.ts` — system.event + hud.update
- `app/src/core/plugin-manager.ts` — hud.update
- `app/src/core/piece-manager.ts` — hud.update

Plugin files to update:
- Voice plugin: voice-piece.ts
- Actor plugin: actor-pool.ts, actor-runner.ts, actor-chat.ts

## Out of Scope

- Distributed bus (WebSocket, IPC)
- Event history/replay
- Middleware/interceptor pattern
- Backpressure

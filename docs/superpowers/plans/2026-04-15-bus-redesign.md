# EventBus Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat topic-string EventBus with typed channels carrying source/target identity, eliminating ambiguity between "process" and "display" messages.

**Architecture:** 6 typed channels (ai.request, ai.stream, tool.request, tool.result, hud.update, system.event). Every message carries source (who sent) and target (who should receive). Pieces subscribe to channels and filter by source/target. No more wildcard pattern matching.

**Tech Stack:** TypeScript, @jarvis/core shared package

---

## File Map

### Modified files — @jarvis/core

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Replace all event types with new channel-based message types |
| `packages/core/src/bus.ts` | New API: publish(msg), subscribe(channel, handler) |
| `packages/core/src/piece.ts` | Remove HUD event types (move to hud.update channel) |
| `packages/core/src/index.ts` | Update re-exports |

### Modified files — app

| File | Change |
|------|--------|
| `app/src/core/bus.ts` | Replace with new channel-based EventBus (pino logging) |
| `app/src/core/types.ts` | Re-export new types from @jarvis/core |
| `app/src/core/piece.ts` | Re-export (HUD types now in types.ts) |
| `app/src/core/jarvis.ts` | ai.request → ai.stream → tool.request/result |
| `app/src/core/hud-state.ts` | Subscribe to hud.update channel |
| `app/src/core/piece-manager.ts` | hud.update for visibility |
| `app/src/core/plugin-manager.ts` | hud.update |
| `app/src/input/chat-piece.ts` | ai.request + ai.stream (filter target=main) |
| `app/src/input/grpc-piece.ts` | hud.update |
| `app/src/input/grpc.ts` | ai.request + ai.stream (filter target=grpc-*) |
| `app/src/input/hud-chat.ts` | ai.request + ai.stream |
| `app/src/tools/executor.ts` | tool.request → tool.result |
| `app/src/output/token-counter.ts` | system.event (api.usage) |
| `app/src/mcp/manager.ts` | system.event + hud.update |

### Modified files — plugins

| File | Change |
|------|--------|
| Voice: `pieces/voice-piece.ts` | ai.stream (target=main, complete) + system.event + hud.update |
| Actors: `pieces/actor-pool.ts` | ai.request + ai.stream + hud.update |
| Actors: `pieces/actor-runner.ts` | ai.request (target=actor-*) → ai.stream |
| Actors: `pieces/actor-chat.ts` | ai.request + ai.stream (target=actor-*) |

---

## Task 1: New bus types and EventBus in @jarvis/core

Replace all types in `packages/core/src/types.ts` with the new channel-based message system. Replace EventBus in `packages/core/src/bus.ts`. Update `piece.ts` to remove HUD event types (they become part of HudUpdateMessage). Update `index.ts`.

**Key types to implement:**
- Channel type: `"ai.request" | "ai.stream" | "tool.request" | "tool.result" | "hud.update" | "system.event"`
- BusMessage base: id, timestamp, source, target?, channel
- Per-channel message interfaces: AIRequestMessage, AIStreamMessage, ToolRequestMessage, ToolResultMessage, HudUpdateMessage, SystemEventMessage
- New EventBus: `publish(msg)`, `subscribe(channel, handler)` — no more topic strings or patterns
- HudPieceData stays in piece.ts but HudPieceAddEvent/UpdateEvent/RemoveEvent are replaced by HudUpdateMessage with action field

**Commit:** `feat: new typed channel EventBus in @jarvis/core`

---

## Task 2: New bus in app with pino logging

Replace `app/src/core/bus.ts` with the new channel-based EventBus that uses pino logging. Update `app/src/core/types.ts` to re-export new types. Update `app/src/core/piece.ts` to re-export (HUD types now from types.ts).

The app's EventBus is identical to @jarvis/core's but uses pino instead of console for logging.

**Commit:** `feat: new typed channel EventBus in app`

---

## Task 3: Migrate JarvisCore

Update `app/src/core/jarvis.ts`:
- Subscribe to `ai.request` (filter: target === "main" or target starts with "grpc-")
- Subscribe to `tool.result` (filter: target matches current session)
- Publish `ai.stream` with event delta/complete/error, source="jarvis-core", target=sessionId
- Publish `tool.request` with source="jarvis-core", target=sessionId
- Publish `system.event` for api.usage
- Publish `hud.update` for piece lifecycle
- Message queue: queue ai.request messages when session is busy

**Commit:** `refactor: migrate JarvisCore to typed channels`

---

## Task 4: Migrate ToolExecutor and TokenCounter

Update `app/src/tools/executor.ts`:
- Subscribe to `tool.request`
- Publish `tool.result` with matching source/target
- Publish `hud.update`

Update `app/src/output/token-counter.ts`:
- Subscribe to `system.event` (filter: event === "api.usage")
- Publish `hud.update`

**Commit:** `refactor: migrate ToolExecutor and TokenCounter to typed channels`

---

## Task 5: Migrate ChatPiece, GrpcPiece, HudState

Update `app/src/input/chat-piece.ts`:
- Publish `ai.request` (source="user", target="main") on user input
- Subscribe to `ai.stream` (filter: target === "main") for SSE streaming
- Subscribe to `ai.request` (filter: target === "main") to display user messages in chat
- Remove all pattern subscriptions
- Use message.source as label in SSE broadcast

Update `app/src/input/grpc-piece.ts` and `app/src/input/grpc.ts`:
- Publish `ai.request` (source="grpc", target="grpc-{clientId}")
- Subscribe to `ai.stream` (filter: target === "grpc-{clientId}")

Update `app/src/input/hud-chat.ts`:
- Same pattern as grpc adapter

Update `app/src/core/hud-state.ts`:
- Subscribe to `hud.update`
- Handle action: add/update/remove

Update `app/src/core/piece-manager.ts`:
- Publish `hud.update` for visibility changes

Update `app/src/core/plugin-manager.ts`:
- Publish `hud.update`

Update `app/src/mcp/manager.ts`:
- Publish `system.event` for MCP connections
- Publish `hud.update`

**Commit:** `refactor: migrate input pieces, HudState, and managers to typed channels`

---

## Task 6: Migrate voice plugin

Update `~/.jarvis/plugins/jarvis-plugin-voice/pieces/voice-piece.ts`:
- Subscribe to `ai.stream` (filter: target === "main", event === "complete") for TTS
- Publish `system.event` (source="voice", event="tts.health") instead of input.prompt for notifications
- Publish `hud.update` instead of hud.piece.add/update/remove

**Commit:** `refactor: migrate voice plugin to typed channels`

---

## Task 7: Migrate actor plugin

Update `~/dev/personal/jarvis-plugin-actors/pieces/actor-pool.ts`:
- actor_dispatch tool publishes `ai.request` (source="jarvis-core", target="actor-{name}")
- Subscribe to `ai.stream` (filter: event=complete, target=main, source=actorName) to update pool state
- Publish `ai.stream` (source=actorName, target="main", event="complete") for results in main chat
- Publish `hud.update`

Update `~/dev/personal/jarvis-plugin-actors/pieces/actor-runner.ts`:
- Subscribe to `ai.request` (filter: target starts with "actor-")
- Publish `ai.stream` (source=actorName, target="actor-{name}") during execution
- Publish `ai.stream` (source=actorName, target="main", event="complete") when done

Update `~/dev/personal/jarvis-plugin-actors/pieces/actor-chat.ts`:
- Subscribe to `ai.request` (filter: target starts with "actor-") for history capture
- Subscribe to `ai.stream` (filter: target starts with "actor-") for SSE
- Publish `ai.request` (source="user", target="actor-{name}") for direct messages

**Commit:** `refactor: migrate actor plugin to typed channels`

---

## Task 8: Rebuild UI and integration test

- Rebuild UI: `cd app/ui && npm run build`
- Start JARVIS, verify all pieces load
- Test main chat (user → JARVIS → response with label JARVIS)
- Test actor dispatch (JARVIS → alice → result appears in main chat with label ALICE)
- Test actor direct chat (user talks to alice in panel, messages stay in panel)
- Test voice (TTS triggers on main chat complete, orb reacts)
- Test plugin disable/enable
- Fix any integration issues

**Commit:** `fix: integration adjustments for typed channel bus`

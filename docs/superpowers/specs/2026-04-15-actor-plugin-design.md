# Actor Plugin — Extract actors from core to plugin

**Date:** 2026-04-15
**Status:** Draft
**Project:** JARVIS

## Goal

Extract the monolithic ActorPiece (580 lines) from the JARVIS core into a standalone plugin (`jarvis-plugin-actors`) with 3 specialized pieces, unified bus communication, and extended PluginContext.

## Decisions

- **3 pieces**: ActorPoolPiece (lifecycle/tools/HUD), ActorRunnerPiece (task execution/AI sessions), ActorChatPiece (HTTP routes/SSE)
- **AI session interfaces in @jarvis/core**: AISession, AISessionFactory, AIStreamEvent extracted to shared package
- **Route registration via PluginContext**: `ctx.registerRoute(method, path, handler)` adds endpoints to the main HTTP server
- **Tool execution**: plugin has both options — registry direct (`ctx.toolRegistry.execute()`) and bus (`actor.{name}.tool.request`). Plugin chooses per use case.
- **One initiative**: extend PluginContext + extract actor + restructure, all together.
- **Renderers stay in app for now**: ActorChat and ActorPoolRenderer remain in the app UI. Plugin provides data via bus/HTTP.

## @jarvis/core Extensions

### AISession interfaces

New file `packages/core/src/ai.ts`:

```typescript
interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string): AsyncGenerator<AIStreamEvent, void>;
  addToolResults(toolCalls: ToolCall[], results: ToolResult[]): void;
  continueAndStream(): AsyncGenerator<AIStreamEvent, void>;
  close(): void;
}

interface AISessionFactory {
  create(options?: { label?: string }): AISession;
  createWithPrompt(prompt: string, options?: { label?: string }): AISession;
}
```

### PluginContext extensions

```typescript
interface PluginContext {
  bus: EventBus;
  toolRegistry: ToolRegistry;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: AISessionFactory;
  registerRoute: (method: string, path: string, handler: RouteHandler) => void;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;
```

### HttpServer route registration

The app's HttpServer gains a `registerRoute(method, path, handler)` method. Plugin routes are namespaced under `/plugins/{pluginName}/...`. The PluginManager wraps this to auto-prefix routes with the plugin name.

## New Bus Topics

```
actor.dispatch          → ActorPoolPiece publishes, ActorRunnerPiece consumes
                          payload: { name, role, task, replySessionId }

actor.dispatch.result   → ActorRunnerPiece publishes when task completes
                          payload: { name, result, replySessionId }
```

Existing topics remain unchanged:
- `core.actor-{name}.stream.delta` — token streaming
- `core.actor-{name}.stream.complete` — response complete
- `core.actor-{name}.error` — errors
- `input.prompt` — used for result notification and direct messages

Tool topics (optional, plugin decides):
- `actor.{name}.tool.request` — if plugin chooses bus-based tool execution
- `actor.{name}.tool.result` — response from ToolExecutor

## Plugin Structure

```
jarvis-plugin-actors/
├── plugin.json
├── package.json
├── pieces/
│   ├── index.ts              createPieces(ctx) → [ActorPoolPiece, ActorRunnerPiece, ActorChatPiece]
│   ├── actor-pool.ts         pool lifecycle, tools, HUD
│   ├── actor-runner.ts       task execution, AI sessions, stream
│   ├── actor-chat.ts         HTTP routes via ctx.registerRoute(), SSE, history
│   └── types.ts              Actor, ActorRole, dispatch event types
└── renderers/
    └── ActorPoolRenderer.tsx  actor list with status (uses app CSS classes)
```

### ActorPoolPiece

Manages the actor pool. Maintains `Map<string, Actor>`. Registers 4 tools: `actor_dispatch`, `actor_list`, `actor_kill`, `bus_publish`. On dispatch, validates actor (create or reuse), publishes `actor.dispatch` on bus. Consumes `actor.dispatch.result` to notify the originating session via `input.prompt`. Publishes HUD panel with actor count, status, roles.

### ActorRunnerPiece

Stateless task worker. Consumes `actor.dispatch` from bus. Creates/reuses AI sessions via `ctx.sessionFactory.createWithPrompt()`. Runs the stream+tool loop (max 15 rounds). Publishes `core.actor-{name}.stream.*` events during execution. Uses `ctx.toolRegistry.execute()` for tool calls (direct, not via bus). When done, publishes `actor.dispatch.result`. Manages session instances internally (keyed by actor name for reuse).

### ActorChatPiece

Registers HTTP routes on the main server via `ctx.registerRoute()`:
- `GET /plugins/actors/{name}/stream` — SSE, subscribes to `core.actor-{name}.stream.*`
- `POST /plugins/actors/{name}/send` — publishes `input.prompt` with sessionId `actor-{name}`
- `GET /plugins/actors/{name}/history` — returns chat history array

Maintains per-actor chat history (capped at 500 entries) and SSE client sets.

## What Gets Removed from Core

- `app/src/core/actor-piece.ts` — deleted (580 lines)
- `app/actor-system.md` — moves to plugin
- `app/src/main.ts` — remove ActorPiece from pieces array, remove import
- `app/src/main.ts` — remove ActorPiece constructor (registry, factory args)

What stays in app:
- `app/ui/src/components/panels/ActorChat.tsx` — stays (consumes SSE from new routes)
- `app/ui/src/components/renderers/ActorPoolRenderer.tsx` — stays (renders pool data)
- HudRenderer special handling for `actor-pool` click → open ActorChat — stays

The ActorChat.tsx needs its SSE URL updated from `http://localhost:50056/{name}/stream` to `http://localhost:50052/plugins/actors/{name}/stream`.

## Data Flow

```
User asks JARVIS to dispatch actor
    → JarvisCore calls actor_dispatch tool
    → ActorPoolPiece validates, publishes actor.dispatch

ActorRunnerPiece consumes actor.dispatch
    → ctx.sessionFactory.createWithPrompt(prompt)
    → session.sendAndStream(task)
    → publishes core.actor-{name}.stream.delta (tokens)
    → tool call → ctx.toolRegistry.execute(calls)
    → session.addToolResults() → continueAndStream()
    → publishes core.actor-{name}.stream.complete
    → publishes actor.dispatch.result { name, result }

ActorPoolPiece consumes actor.dispatch.result
    → publishes input.prompt on replySessionId (JARVIS gets the result)
    → updates HUD

ActorChatPiece (parallel):
    → SSE clients receive core.actor-{name}.stream.* in real-time
    → POST /send publishes input.prompt for direct actor messages
```

## Out of Scope

- Migrating ActorChat.tsx and ActorPoolRenderer.tsx to plugin renderers (stay in app)
- Actor-to-actor communication beyond bus_publish tool
- Actor role customization via plugin config
- Actor session persistence to disk
- Actor session compaction (no message history trimming)

## Success Criteria

1. `plugin_install` with actors repo loads all 3 pieces
2. `actor_dispatch` creates actor, runs task autonomously, reports result
3. Actor chat works via main HTTP server routes (not separate port)
4. Actor stream events visible in chat SSE (ChatPiece continues filtering correctly)
5. `plugin_disable` stops all actors, removes tools, removes HUD panel
6. Port 50056 no longer used (HTTP routes on 50052)
7. `app/src/core/actor-piece.ts` deleted, no actor references in core

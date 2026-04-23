# Unified Chat Refactor — Implementation Notes

> Breaking change for `@jarvis/core` v3.0.0
> Goal: one chat system, N sessions (main + actor-*)

## Phase 0 — Discovery Findings

### Current architecture (duplication map)

| Concern | Core (`main`) | Plugin actors (`actor-*`) |
|---------|---------------|----------------------------|
| Piece | `ChatPiece` (`src/input/chat-piece.ts`) | `ActorChatPiece` (`plugins/.../actor-chat.ts`) |
| SSE broadcast | `streamClients: Set<ServerResponse>` | `sseClients: Map<actorName, Set<ServerResponse>>` |
| Bus subscription | Hardcoded to `timelineSessions` (default `["main"]`) | Per-actor dynamic `ensureSubscribed(name)` |
| Endpoints | `/chat/send`, `/chat-stream`, `/chat/history`, `/chat/abort` | `/plugins/actors/<name>/{send,stream,history,abort,kill}` |
| Publish target | `ai.request target=main` | `ai.request target=actor-<name>` |
| Renderer | `ChatPanel` (core, `ui/src/components/panels/ChatPanel.tsx`) | `ActorChatRenderer` (thin wrapper that steals ChatPanel via `window.__JARVIS_COMPONENTS`) |
| History parsing | `handleHistory()` in ChatPiece | Duplicated `parseMessagesToHistory()` in ActorChatPiece |

### Key observations

1. **`ChatPanel` already accepts URLs as props** (`streamUrl`, `sendUrl`, `historyUrl`, `abortUrl`). No component-level changes needed if we unify the URLs by making them `?sessionId=X` variants.
2. **`ActorChatRenderer` is just a URL-plumbing wrapper** — 38 lines that currently point at `/plugins/actors/<name>/*`. Once core endpoints accept `sessionId`, this wrapper goes away entirely.
3. **Duplicate SSE broadcast code** — `ChatPiece.broadcast()` and `ActorChatPiece.broadcast()` do the same work, differing only in which client set to hit.
4. **Duplicate history parser** — `ChatPiece.handleHistory()` and `ActorChatPiece.parseMessagesToHistory()` parse session messages to chat entries with ~95% identical logic.
5. **Ephemeral context mutation** — `ChatPiece.broadcast` in `handleSend` prepends a synthetic `user` event to the SSE stream before publishing `ai.request`. This avoids a race but creates a UX assumption. Needs to carry over for every session.
6. **Core exposes `window.__JARVIS_COMPONENTS = { ChatPanel }` already** (`ui/src/main.tsx:12`). HudRenderer does not currently know how to resolve `renderer: { plugin: null }` to `window.__JARVIS_COMPONENTS`. That's the gap for Phase 2.

### Breaking changes announced

All under `@jarvis/core` **v3.0.0**:

| Change | Before | After |
|--------|--------|-------|
| `POST /chat/send` body | `{ prompt, images? }` | `{ sessionId, prompt, images? }` — **sessionId required** |
| `GET /chat-stream` | no query | `?sessionId=X` — **required** |
| `GET /chat/history` | no query | `?sessionId=X` — **required** |
| `POST /chat/abort` | no body | `{ sessionId }` — **required** |
| `POST /chat/clear-session` | no body (implicit `main`) | `{ sessionId }` — **required** |
| `POST /chat/compact` | no body (implicit `main`) | `{ sessionId }` — **required** |
| `ChatPanel` props | URL strings | `sessionId` + optional URL overrides |
| HudPieceData renderer | `{ plugin: "name", file: "X" }` | `{ plugin: "name" \| null, file: "X" }` — **`plugin: null` ⇒ core renderer** |
| Plugin `actor-chat` piece | exists | **DELETED** |
| Plugin `ActorChatRenderer.tsx` | exists | **DELETED** |
| Plugin route `/plugins/actors/<name>/*` | exists | **DELETED** (replaced by core `sessionId` endpoints) |

### Endpoints — final shape

```
POST /chat/send          → { sessionId, prompt, images? }
GET  /chat-stream?sessionId=X
GET  /chat/history?sessionId=X
POST /chat/abort         → { sessionId }
POST /chat/clear-session → { sessionId }
POST /chat/compact       → { sessionId }
```

Legacy `POST /chat` (the `handleChat` SSE streaming endpoint) — **deprecated** but can remain for one release. Refactor later.

### Core chat piece — internal changes

- `streamClients: Set<ServerResponse>` → `streamClients: Map<sessionId, Set<ServerResponse>>`
- `timelineSessions` drops — every subscribed session has its own stream pool
- `broadcast(sessionId, data)` — write only to matching pool
- bus subscriber: `msg.target` → route to `streamClients.get(msg.target)`
- `handleSend(req, res)`: parse `sessionId` from body, validate, publish `ai.request` with `target: sessionId`, broadcast user event to that sessionId's pool
- `handleStream(req, res)`: parse `sessionId` from query, register client in right pool
- `handleHistory(req, res)`: parse `sessionId` from query, pull from `SessionManager.get(sessionId)`

### Frontend — HudRenderer core renderer support

Where HudRenderer currently loads `/plugins/<name>/renderers/<file>.js` dynamically via esbuild, add:

```ts
if (pieceData.renderer?.plugin === null) {
  // Core renderer — resolve from window.__JARVIS_COMPONENTS
  const Component = (window as any).__JARVIS_COMPONENTS?.[pieceData.renderer.file];
  if (Component) return Component;
}
```

Actor pool publishes panels like:

```ts
{
  renderer: { plugin: null, file: "ChatPanel" },
  data: { sessionId: `actor-${name}`, assistantLabel: name.toUpperCase() },
}
```

ChatPanel receives `sessionId` via the `data` prop path (`props.state.data.sessionId`). Builds default URLs:

```ts
const streamUrl = props.streamUrl ?? `/chat-stream?sessionId=${sessionId}`
// same for send, history, abort
```

### Phase ordering

1. **Phase 1 — Backend** (`chat-piece.ts`, `server.ts`) — new endpoints, multi-pool SSE, sessionId-aware
2. **Phase 2 — Frontend** (`ChatPanel.tsx`, `HudRenderer`, `App.tsx`) — sessionId prop, core-renderer resolution
3. **Phase 3 — Plugin actors cleanup** — delete `actor-chat.ts`, `ActorChatRenderer.tsx`, route `/plugins/actors/*`, rewire `actor-pool.openActorChat` to publish core renderer
4. **Phase 4 — Versioning** — `@jarvis/core` 3.0.0, CHANGELOG, COMPATIBILITY.md
5. **Phase 5 — Functional tests** — main + 2 actors + abort isolation + switch between sessions

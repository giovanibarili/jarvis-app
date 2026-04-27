# @jarvis/core — Changelog

All notable changes to this package will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-04-27

### Changed — Plugin renderer bundle format

Renderer endpoint `GET /plugins/:name/renderers/:file.js` now emits an IIFE-wrapped ESM shim instead of a plain ESM module. Output structure:

```js
const { createElement, ... } = window.__JARVIS_REACT;        // banner — top-level
const { useHudState, ... } = window.__JARVIS_HUD_HOOKS || {};
var __jarvis_renderer = (() => { /* ...bundle... */ })();    // IIFE wrap
export default __jarvis_renderer.default;                    // footer — re-export
```

### Why

Heavy renderer bundles like `neovis.js` + `vis-network` include core-js polyfills that declare `var createElement` at the bundle's top level. Under `format: "esm"` that var collided with the banner's `const createElement` from `window.__JARVIS_REACT`, throwing `Identifier 'createElement' has already been declared` and crashing the renderer at parse time. The IIFE wrap pushes bundle locals into a nested function scope while keeping banner identifiers reachable via closure, eliminating the collision without changing the runtime contract.

### Compatibility

- **Backwards compatible.** The HTTP endpoint still returns valid ESM (the IIFE is wrapped in a tiny ESM shim that re-exports `default`). Frontend continues to use `import("/plugins/.../renderers/X.js")` and reads `module.default`.
- All 8 existing plugin renderers (jarvis-plugin-actors, jarvis-plugin-canvas, jarvis-plugin-mnemosyne ×5, jarvis-plugin-tasks) tested: bundle + parse OK.
- Banner identifiers (`createElement`, `Fragment`, `useEffect`, etc.) and HUD hooks (`useHudState`, `useHudPiece`, `useHudReactor`) remain accessible from inside the IIFE via closure — plugin code that imports nothing and uses bare globals (per the renderer convention) keeps working unchanged.
- New: bundles tolerate transitive deps that declare top-level `var <name>` shadowing banner identifiers.

### Public API contract

- `format: "iife"` + `globalName: "__jarvis_renderer"` + `footer: "export default __jarvis_renderer.default;"` is now the documented bundle format. Plugins should not depend on this implementation detail; consume only the ESM `default` export.

## [0.3.0] — 2026-04-27

### Added — Chat Anchor Registry

New optional `PluginContext.chatAnchors` exposes a `ChatAnchorRegistry` for planting UI elements in a fixed slot above the chat input. Anchors persist across AI turns and never scroll away with the timeline.

- `ChatAnchorRegistry.set(spec)` — plants an anchor; returns a `ChatAnchorHandle` for `update()` / `setRenderer()` / `clear()`.
- `ChatAnchorRegistry.list(sessionId)` — read-only snapshot.
- `ChatAnchorRegistry.clearSession(sessionId)` — wipe all anchors for a session.
- Renderer can be a built-in (`{ builtin: "choice-card" }`) or a plugin-bundled React component (`{ plugin, file }`).
- Backend `onAction(payload)` handler is invoked when the frontend POSTs to `/chat/anchor-action`.

Transport is pure HTTP (long-poll) — no bus events. Endpoints:
- `GET  /chat/anchors?sessionId=…&since=<version>&timeoutMs=<ms>`
- `POST /chat/anchor-action`

The field is **optional** — older plugins that don't need anchors continue to work unchanged.

### Compatibility

- Backwards compatible: existing `PluginContext` consumers keep working.
- New types exported: `ChatAnchorRegistry`, `ChatAnchorSpec`, `ChatAnchorHandle`, `ChatAnchorRenderer`, `ChatAnchorRendererBuiltin`, `ChatAnchorRendererPlugin`.

## [0.2.2] — 2026-04-23

### Breaking Changes — Unified Chat Refactor

Chat is now **session-agnostic**: a single unified chat system services any number of sessions (`main`, `actor-*`, or arbitrary labels). The root `jarvis-app` knows nothing about the concept of "actor" — it operates on opaque `sessionId` strings.

#### HTTP API — sessionId is now required

All `/chat/*` endpoints require a `sessionId`. Missing or empty → `HTTP 400`.

| Endpoint | Method | Required shape |
|----------|--------|----------------|
| `/chat/send` | POST | body: `{ sessionId, prompt, images? }` |
| `/chat-stream` | GET | query: `?sessionId=X` |
| `/chat/history` | GET | query: `?sessionId=X` |
| `/chat/abort` | POST | body: `{ sessionId }` |
| `/chat/clear-session` | POST | body: `{ sessionId }` |
| `/chat/compact` | POST | body: `{ sessionId }` |

Removed: `POST /chat` (legacy SSE streaming endpoint).

#### HudPieceData renderer — core renderer opt-in

`renderer.plugin` now accepts `null` to resolve a core renderer from `window.__JARVIS_COMPONENTS`:

```ts
{ plugin: null, file: "ChatPanel" }  // core ChatPanelHudAdapter
{ plugin: "jarvis-plugin-x", file: "MyRenderer" }  // plugin renderer (unchanged)
```

#### ChatPanel — props changed

Old: `streamUrl`, `sendUrl`, `abortUrl`, `historyUrl`, `assistantLabel`.

New: `sessionId` (required) + `assistantLabel` + optional features/labels. All URLs are derived internally from `sessionId`. A core `ChatPanelHudAdapter` is exposed on `window.__JARVIS_COMPONENTS.ChatPanelHudAdapter` so HUD pieces can mount it via `renderer: { plugin: null, file: "ChatPanel" }` with `data.sessionId`.

#### Server callbacks — sessionId-scoped

`HttpServer` callbacks now take `sessionId` as their first argument:

```ts
server.setOnAbort((sessionId: string) => ...)
server.setOnClearSession((sessionId: string) => ...)
server.setOnCompact((sessionId: string) => ...)
```

#### ChatPiece — multi-pool SSE

`ChatPiece.broadcastEvent(data)` became `broadcastEvent(sessionId, data)`. Internal state `streamClients` went from `Set<ServerResponse>` to `Map<sessionId, Set<ServerResponse>>`. Removed: `DEFAULT_SESSION` constant, `timelineSessions`, `addTimelineSession`, `removeTimelineSession`.

#### DiffViewer — sessionId propagation

`hud_show_diff`/`hud_show_file`/`hud_compare_files` now forward the calling session's `__sessionId` into `data.sessionId` on the HUD panel so Accept/Reject replies route back to the correct chat.

### Removed — jarvis-plugin-actors

- `actor-chat` piece — replaced by core chat endpoints
- `ActorChatRenderer` — replaced by core `ChatPanelHudAdapter`
- Routes `/plugins/actors/<name>/{send,stream,history,abort}` — replaced by `/chat/{send,stream,history,abort}` with `sessionId`

Retained (administrative lifecycle only):
- `POST /plugins/actors/create` — spawn actor
- `POST /plugins/actors/<name>/kill` — destroy actor

### Migration

- Any plugin calling `/chat/send` must include `sessionId` in the body.
- Any plugin embedding `ChatPanel` as a React component must pass `sessionId` instead of URL props.
- Any plugin mounting a chat in the HUD should publish `renderer: { plugin: null, file: "ChatPanel" }` with `data: { sessionId, assistantLabel? }`.

## [0.3.0] — 2025-07-20

### Added
- **GraphHandle & GraphNodeChild** — types exported from `@jarvis/core` for plugins to register children in the HUD graph
  - `GraphHandle` provides `setChildren()` and `update()` scoped to a piece's graph node
  - `GraphNodeChild` defines the shape of child nodes (id, label, status, meta, recursive children)
- **PluginContext.graphHandle** — optional factory `(pieceId: string) => GraphHandle`
  - Plugins can now enrich their piece's graph node with dynamic children (e.g. active skills, connected services)
  - Optional field (backward compatible with existing plugins)

## [0.2.1] — 2026-04-21

### Added
- **SessionManager interface** — `SessionManager`, `ManagedSession`, `SessionState` types exported from `@jarvis/core`
  - Central manager for ALL AI sessions (main, grpc-*, actor-*)
  - Provides `get()`, `getWithPrompt()`, `setState()`, `abort()`, `save()`, `close()`, `has()`
  - `getWithPrompt()` supports creating sessions with custom base prompt and role context (for actors)
- **PluginContext.sessionManager** — optional field added to `PluginContext`
  - Plugins can now access the central SessionManager for session persistence, restore, and state tracking
  - Optional field (backward compatible with existing plugins)

## [2.0.0] — 2025-07-19

### Added
- **HUD SSE Stream** — `GET /hud-stream` endpoint replaces polling `GET /hud` for real-time UI updates
  - Backend pushes deltas per-piece via SSE (`set` / `remove` actions)
  - Initial `snapshot` event provides full state on connect
  - Frontend maintains reactive `Map<pieceId, HudComponentState>` via `useSyncExternalStore`
- **Frontend hooks exposed to plugins** via `window.__JARVIS_HUD_HOOKS`:
  - `useHudState()` — full HudState (reactor + components array)
  - `useHudPiece(id)` — single piece state (granular subscription)
  - `useHudReactor()` — reactor state only
- **Plugin renderer banner** now includes `useHudState`, `useHudPiece`, `useHudReactor`, `useSyncExternalStore`
- **Settings cache** — `load()` uses in-memory cache with mtime validation (avoids excessive disk reads)
- **Per-session state tracking** in JarvisCore — `deriveGlobalState()` from individual session states
- **Token estimation fix** — uses real API `cache_read + cache_creation` values instead of char/4 heuristic
- **Smart conversation trimming** — ensures restored conversations start on a user message

### Changed
- `HudState` class now manages SSE client connections (`addStreamClient` / `removeStreamClient`)
- `HudState.getState()` kept for backward compat (initial snapshot, `GET /hud` still works)
- `settings.ts` `load()` returns cached object when file mtimes haven't changed
- `settings.ts` `save()` updates cache immediately after write
- `AnthropicSession` verbose message logging demoted to debug level
- `EventBus` error logging now uses structured objects instead of string concatenation

### Breaking
- `GET /hud` polling is **deprecated** in favor of `GET /hud-stream` SSE
  - `GET /hud` still works and returns the same payload (backward compatible)
  - New UI code should use `useHudState()` / `useHudPiece()` hooks instead
- Plugin renderers now have access to `useHudPiece(id)` for reactive per-piece updates
  - Old pattern (reading from `state` prop passed by HudRenderer) still works

## [1.0.0] — 2025-07-15

Initial release. EventBus, Piece, PluginContext, CapabilityRegistry, AISession interfaces.

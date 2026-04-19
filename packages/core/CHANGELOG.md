# @jarvis/core — Changelog

All notable changes to this package will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

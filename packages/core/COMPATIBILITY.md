# @jarvis/core — Compatibility Guide

## Versioning Policy

This package follows **Semantic Versioning (semver)**:

- **MAJOR** — breaking changes to public API (types, interfaces, bus channels, plugin contract)
- **MINOR** — new features, new optional fields, new hooks (backward compatible)
- **PATCH** — bug fixes, performance improvements, internal refactors

## Plugin Compatibility Matrix

| @jarvis/core | Plugin API | HUD Stream | Notes |
|---|---|---|---|
| 1.x | `state` prop only | ❌ polling `/hud` every 2s | Original architecture |
| 2.x | `state` prop + `useHudPiece()` | ✅ SSE `/hud-stream` | Backward compatible — `state` prop still works |

## Public API Surface

### Stable (do NOT break without major version bump)

These are consumed by plugins and must remain backward compatible:

#### TypeScript Interfaces (`@jarvis/core`)
- `Piece` — `id`, `name`, `start(bus)`, `stop()`, `systemContext?()`
- `PluginContext` — `bus`, `capabilityRegistry`, `config`, `pluginDir`, `sessionFactory`, `registerRoute`, `saveConfig`, `registerSlashCommand`, `unregisterSlashCommand`
- `PluginManifest` — `name`, `version`, `description`, `author?`, `entry?`, `capabilities?`
- `HudPieceData` — `pieceId`, `type`, `name`, `status`, `data`, `position?`, `size?`, `visible?`, `ephemeral?`, `renderer?`
- `EventBus` — `publish(msg)`, `subscribe(channel, handler)`, `stats`
- `CapabilityRegistry` — `register(def)`, `getDefinitions()`, `execute(calls)`, `registerSlashCommand`, `unregisterSlashCommand`, `getSlashCommands()`, `names`, `size`
- Bus channels: `ai.request`, `ai.stream`, `capability.request`, `capability.result`, `hud.update`, `system.event`
- All message types: `AIRequestMessage`, `AIStreamMessage`, `CapabilityRequestMessage`, `CapabilityResultMessage`, `HudUpdateMessage`, `SystemEventMessage`

#### Window Globals (consumed by plugin renderers)
- `window.__JARVIS_REACT` — React instance (`createElement`, `Fragment`, all hooks)
- `window.__JARVIS_HUD_HOOKS` — `{ useHudState, useHudPiece, useHudReactor }` (added in 2.0)

#### HTTP Endpoints (consumed by plugins via `registerRoute` and `fetch`)
- `GET /hud` — full HUD state snapshot (JSON)
- `GET /hud-stream` — SSE delta stream (added in 2.0)
- `POST /chat/send` — send message to AI
- `GET /chat-stream` — SSE chat event stream
- `GET /chat/history` — message history for UI hydration
- `POST /chat/abort` — abort current AI operation
- `GET /plugins/{name}/renderers/{file}.js` — compiled plugin renderer

#### Plugin Renderer esbuild Banner
Injected variables available in all `.tsx` plugin renderers:
```js
// React (from window.__JARVIS_REACT)
createElement, Fragment, useEffect, useRef, useState,
useCallback, useMemo, useSyncExternalStore

// HUD hooks (from window.__JARVIS_HUD_HOOKS) — added in 2.0
useHudState, useHudPiece, useHudReactor
```

### Internal (may change without notice)

These are implementation details NOT consumed by plugins:
- `HudState` class internals (stream client management, delta format)
- `JarvisCore` state machine internals (`sessionStates`, `deriveGlobalState`)
- `SessionManager` internals
- `AnthropicSession` / `AnthropicSessionFactory` internals
- Settings file format (`.jarvis/settings.user.json`)
- Conversation store format (`.jarvis/sessions/*.json`)
- Log format and log buffer API

## Migration Guide: 1.x → 2.x

### For plugin renderers (frontend)

**No changes required.** The `state` prop passed by HudRenderer still works exactly as before.

**Optional optimization:** Use `useHudPiece(pieceId)` for granular reactivity:
```tsx
// Before (1.x) — re-renders on ANY HUD change
export default function MyRenderer({ state }: { state: any }) {
  const data = state.data
  return <div>{data.myValue}</div>
}

// After (2.x) — re-renders only when THIS piece changes
export default function MyRenderer({ state }: { state: any }) {
  const piece = useHudPiece(state.id)
  const data = piece?.data ?? state.data
  return <div>{data.myValue}</div>
}
```

### For plugin pieces (backend)

**No changes required.** Publishing `hud.update` on the bus works exactly as before. The HudState SSE layer handles delta broadcasting automatically.

# Plugin System Phase 2 — Dynamic Pieces & Renderers

**Date:** 2026-04-14
**Status:** Draft
**Codename:** JARVIS Plugin Phase 2

## Goal

Enable plugins to contribute backend pieces (TypeScript) and frontend renderers (TSX) that load dynamically at runtime, without build steps. Validate with the existing `jarvis-plugin-voice` repo.

## Decisions

- **Monorepo with workspaces** — `jarvis-app` becomes a monorepo with `@jarvis/core` as shared package
- **On-the-fly TS compilation** — plugins ship `.ts` source, JARVIS imports via tsx (no build step)
- **Dynamic import TSX renderers** — backend compiles with esbuild, serves via HTTP, frontend lazy-loads
- **`@jarvis/core` shared package** — contains real EventBus + interfaces, plugins use as peerDependency
- **Voice plugin as test case** — migrate VoicePiece + VoiceRenderer into the existing plugin repo

## Architecture

### Monorepo Structure

```
jarvis-app/
├── package.json                   ← workspaces: ["packages/*", "app"]
├── tsconfig.base.json
├── packages/
│   └── core/                      ← @jarvis/core
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts           ← re-exports
│           ├── piece.ts           ← Piece interface + HudPieceData
│           ├── bus.ts             ← EventBus (real class)
│           ├── types.ts           ← PluginContext, PluginManifest, shared types
│           └── tools.ts           ← ToolDefinition, ToolRegistry interface
├── app/                           ← main application
│   ├── package.json               ← depends on @jarvis/core
│   ├── tsconfig.json
│   ├── src/
│   ├── ui/
│   ├── tools/
│   ├── mcp.json
│   ├── jarvis-system.md
│   └── actor-system.md
└── plugins/                       ← dev symlinks (gitignored)
    └── voice -> ~/dev/personal/jarvis-plugin-voice
```

### Plugin Contract

**plugin.json manifest:**

```json
{
  "name": "jarvis-plugin-voice",
  "version": "1.0.0",
  "description": "Voice I/O for JARVIS",
  "author": "giovanibarili",
  "capabilities": {
    "tools": true,
    "prompts": true,
    "pieces": true,
    "renderers": true
  },
  "entry": "pieces/index.ts"
}
```

**Piece factory (pieces/index.ts):**

```typescript
import { PluginContext, Piece } from '@jarvis/core';

export function createPieces(ctx: PluginContext): Piece[] {
  return [new VoicePiece(ctx.bus, ctx.config)];
}
```

**PluginContext injected by JARVIS:**

```typescript
interface PluginContext {
  bus: EventBus;
  toolRegistry: ToolRegistry;
  config: Record<string, unknown>;
  pluginDir: string;
}
```

### Plugin Lifecycle

On `plugin_install` or `plugin_enable`:

1. Clone repo (if install) or read path (if already installed)
2. Read `plugin.json`, validate manifest
3. Load `tools/*.json` — register in ToolRegistry (as today)
4. Load `prompts/*.md` — store raw content (as today)
5. If `capabilities.pieces` + `entry` exists: `await import(entry)` → call `createPieces(ctx)` → register each piece in PieceManager → `piece.start(bus)`
6. If `capabilities.renderers`: scan `renderers/*.tsx` → register mapping `pieceId → URL` for frontend

On `plugin_disable`:

1. Call `piece.stop()` on each plugin piece
2. Unregister from PieceManager
3. Remove renderer mappings
4. Unregister plugin tools from ToolRegistry

### Dynamic Piece Registration

PieceManager gains two methods:

```typescript
registerDynamic(piece: Piece, source: string): void
  // source = "core" | "plugin:{name}"
  // Rejects duplicate piece IDs
  // If PieceManager already started, calls piece.start(bus) immediately
  // Creates settings entry (enabled: true, visible: true)

unregisterDynamic(pieceId: string): void
  // Calls piece.stop()
  // Removes from piece list
  // Publishes hud.piece.remove
  // Preserves settings (layout survives re-enable)
```

No changes needed in AnthropicSessionFactory — it already uses a callback to collect systemContext() from pieces, so dynamic pieces are picked up automatically.

### Dynamic Renderers

**Backend — compile and serve:**

New HTTP endpoint: `GET /plugins/:name/renderers/:file.js`

1. Locates source: `~/.jarvis/plugins/{name}/renderers/{file}.tsx`
2. Compiles with esbuild in memory:
   - Format: ESM
   - Target: esnext (Electron Chromium)
   - External: `react`, `react-dom`, `@jarvis/core`
   - JSX: automatic
3. Caches result (invalidates on plugin update)
4. Serves JS with `Content-Type: application/javascript`

**Frontend — lazy loading:**

```typescript
// Built-in renderers (static imports, as today)
const builtinRenderers = {
  "jarvis-core": JarvisCoreRenderer,
  "chat-output": ChatOutputRenderer,
  // ...
};

// Plugin renderers (lazy loaded)
const pluginRenderers: Record<string, React.LazyExoticComponent<any>> = {};

// HudRenderer resolution:
// 1. Check builtinRenderers[pieceId]
// 2. If piece has renderer metadata, lazy-import from endpoint
// 3. Fallback: GenericRenderer (shows raw data)
```

**HUD state** includes renderer metadata for plugin pieces:

```typescript
{
  pieceId: "voice",
  renderer: { plugin: "voice", file: "VoiceRenderer" }
}
```

**Externals resolution:** Vite build exposes React and ReactDOM as window globals. Plugin renderers import from externals resolved by import map or global lookup.

### Voice Plugin Structure (test case)

```
jarvis-plugin-voice/
├── package.json              ← peerDependencies: { "@jarvis/core": "^1.0.0" }
├── plugin.json               ← capabilities: all true, entry: "pieces/index.ts"
├── pieces/
│   ├── index.ts              ← createPieces(ctx) factory
│   └── voice-piece.ts        ← VoicePiece (TTS/STT lifecycle, HUD events)
├── renderers/
│   └── VoiceRenderer.tsx     ← mic controls, status indicator, voice selector
├── tools/                    ← unchanged (3 existing tools)
│   ├── voice-set.json
│   ├── voice-list.json
│   ├── stt-language.json
│   └── scripts/
└── prompts/                  ← unchanged
    └── voice-context.md
```

VoicePiece based on the deleted `src/output/voice-piece.ts` from commit `62897ec`, adapted to use `@jarvis/core` imports and `createPieces(ctx)` contract.

VoiceRenderer combines the deleted `VoiceInput.tsx` and `VoiceOutput.tsx` into a single component.

## Out of Scope

- Plugin dependency management (plugins don't declare deps on each other)
- Plugin versioning/compatibility checks (no semver enforcement)
- Hot reload (plugin update requires disable+enable)
- Plugin marketplace/registry (install by GitHub URL only)
- Sandbox/security (plugins run with app privileges)
- Multiple renderers per piece (1:1 mapping)

## Success Criteria

1. `plugin_install` with voice repo clones, loads tools/prompts/pieces/renderers
2. VoicePiece appears in `piece_list` with status
3. VoicePiece contributes `systemContext()` to AI prompt
4. VoiceRenderer loads in HUD via lazy import
5. Existing 3 voice tools continue working
6. `plugin_disable` stops piece, removes renderer from HUD
7. `plugin_enable` restarts piece, re-loads renderer

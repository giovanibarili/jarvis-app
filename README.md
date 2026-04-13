# J.A.R.V.I.S.

An open AI assistant you fully own and evolve. Built on a plugin architecture where every capability — voice, tools, HUD panels — is a composable piece you can swap, extend, or replace.

The goal is freedom: freedom to shape your AI interface exactly how you want it, with full access to every layer — from the system prompt re-evaluated on every API call, to the capabilities the AI can use, to the pixels on the HUD. No black boxes, no locked-down behaviors. You build the assistant you actually need.

## Quick Start

```bash
git clone https://github.com/giovanibarili/jarvis-app.git
cd jarvis-app
./setup.sh
```

The setup wizard checks prerequisites, asks for your AI provider (Anthropic or OpenAI), installs dependencies, builds the UI, and starts JARVIS. On macOS it can also create a JARVIS.app in your Applications folder.

## Core Concepts

JARVIS is built on three primitives that compose into anything.

**Pieces** are the building blocks. Every module in the system — chat input, token counter, voice output, gRPC server — is a Piece. A piece implements `start(bus)` and `stop()`, subscribes to events it cares about, publishes events when it has something to say, and optionally contributes context to the AI's system prompt. Pieces don't know about each other. They communicate exclusively through the EventBus, which means you can add, remove, or replace any piece without touching the rest of the system. Pieces can be enabled and disabled at runtime, and their state persists across restarts.

**HUD Panels** are how pieces show themselves. When a piece starts, it can publish a HUD event declaring what type of panel it wants (draggable panel, status indicator, or floating overlay) along with its data. The Electron window picks this up and renders the panel with the appropriate renderer. Panels are draggable, resizable, closable, and their layout is saved automatically. The HUD polls for state every 2 seconds, so panels update in near-real-time as pieces publish new data.

**Plugins** extend JARVIS from external repositories. A plugin is a GitHub repo with a `plugin.json` manifest that can provide pieces (TypeScript backend logic), renderers (TSX frontend components), and capabilities (registered programmatically by pieces). Install a plugin and JARVIS clones the repo, dynamically imports the TypeScript (no build step), compiles the TSX renderers on-demand with esbuild, and wires everything into the running system. Disable a plugin and its pieces stop, its panels disappear from the HUD, and its capabilities are removed. The system prompt updates automatically on the next API call.

These three concepts compose: a plugin provides a piece, the piece registers capabilities and publishes HUD events, the HUD loads the plugin's renderer to display the panel. Everything is hot-swappable at runtime.

## Multi-Provider

JARVIS supports multiple AI providers through a provider-agnostic adapter layer. Switch between providers at runtime — the session resets and the metrics HUD swaps automatically.

**Anthropic (Claude)** — Claude Opus 4.6, Sonnet 4.6, Haiku 4.5. Prompt caching with 4 breakpoints for ~90% token savings. Anthropic Usage HUD with cache hit metrics.

**OpenAI-compatible** — GPT-4o, o3, o4-mini, or any OpenAI-compatible API (Groq, Ollama, Together). OpenAI Usage HUD with prompt/completion metrics.

Switch models by asking JARVIS: "switch to gpt-4o" or "use claude-opus-4-6".

## Plugins

Install plugins by asking JARVIS or by registering them in `.jarvis/settings.user.json`. See [MARKETPLACE.md](MARKETPLACE.md) for available plugins.

```
"Install the voice plugin from github.com/giovanibarili/jarvis-plugin-voice"
```

JARVIS clones the repo, loads pieces and capabilities, compiles renderers, and everything appears in the HUD immediately. No restart needed.

### Plugin Structure

A plugin repo contains:

```
my-plugin/
├── plugin.json              manifest (name, entry, capabilities)
├── package.json             peerDependency on @jarvis/core
├── pieces/
│   ├── index.ts             createPieces(ctx) factory
│   └── my-piece.ts          backend logic
└── renderers/
    └── MyRenderer.tsx       HUD panel component
```

The `createPieces(ctx)` factory receives a `PluginContext` with the EventBus, CapabilityRegistry, config, and plugin directory. Pieces register their own capabilities programmatically and publish HUD events. Renderers use the same CSS classes as the core HUD — they're loaded as ESM modules compiled by esbuild at request time.

## Architecture

Independent Pieces communicate through a typed EventBus with 6 channels. No piece knows about any other.

```
Input Pieces ──→ EventBus ──→ Core ──→ EventBus ──→ Output Pieces
(chat, grpc)       ↕          (AI)        ↕         (voice, HUD,
                Capability              MCP System    metrics)
                System                                    ↕
                                                      Plugins
```

Every message carries `source` (who sent it) and `target` (who should receive it). The 6 channels are: `ai.request` (prompts), `ai.stream` (AI output tokens), `capability.request`/`capability.result` (capability execution), `hud.update` (panel lifecycle), and `system.event` (health, metrics, notifications). Pieces subscribe to channels and filter by source/target — no ambiguity about intent.

The AI brain (JarvisCore) receives prompts, streams responses, and handles capability calls. The system prompt is re-evaluated on every API call — change `jarvis-system.md` or a piece's `systemContext()` and the AI picks it up immediately, no restart needed.

See [ARCHITECTURE.md](ARCHITECTURE.md) for data flow diagrams, directory structure, and how to add new pieces and capabilities.

## Built-in Capabilities

JARVIS ships with capabilities defined as JSON configs — adding a new capability is creating a JSON file and a shell script. Core capabilities include filesystem operations (bash, read/write/edit files, glob, grep, directory listing), web access (web_search via DuckDuckGo, web_fetch with HTML-to-text conversion), scheduling (cron_create for one-shot or recurring prompts, cron_list, cron_delete), model switching (model_set, model_get), and a graceful restart (jarvis_reset). Pieces add their own capabilities at runtime: managing the piece lifecycle, controlling the HUD, connecting to MCP servers.

The Model Context Protocol (MCP) lets JARVIS connect to external services on demand. Configure any MCP-compatible server in `mcp.json` — the AI decides when to connect based on the task. Supports HTTP, SSE, and stdio transports with OAuth and device code flows.

The `PluginContext` provides plugins with access to the EventBus, CapabilityRegistry, AI SessionFactory, HTTP route registration, and persistent config storage — everything needed to build full-featured extensions without touching the core.

## Monorepo Structure

```
jarvis-app/
├── packages/core/       @jarvis/core — shared types, EventBus, Piece interface
├── app/
│   ├── src/             Backend (TypeScript, Node.js)
│   │   ├── ai/          AI providers (Anthropic, OpenAI)
│   │   ├── core/        EventBus, Pieces, Settings, Plugins
│   │   ├── input/       Chat HTTP, gRPC
│   │   ├── capabilities/ Capability registry, executor, loader
│   │   ├── mcp/         MCP client with OAuth
│   │   └── transport/   gRPC server, Electron launcher
│   ├── ui/              React HUD (Vite, Electron)
│   ├── capabilities/    JSON capability configs + shell scripts
│   └── .jarvis/         Runtime (settings, OAuth tokens, logs)
├── setup.sh             Interactive setup wizard
└── docs/                Specs and plans
```

## Settings

JARVIS uses a two-layer settings system:

**`settings.json`** (committed) — Default piece configuration. Every new user gets a working base.

**`settings.user.json`** (gitignored) — Personal config: plugins, model preference, HUD layouts, API keys. Never goes to the repo.

On load, both are deep-merged. Saves always write to the user file.

## Ports

| Port | Service |
|------|---------|
| 50051 | gRPC API |
| 50052 | HTTP (chat, HUD, static, plugin routes) |
| 50053 | Electron screenshot |

Plugin routes are registered on the main HTTP server (50052) via `ctx.registerRoute()`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `JARVIS_MODEL` | claude-sonnet-4-6 | AI model |
| `JARVIS_GRPC_PORT` | 50051 | gRPC port |
| `LOG_LEVEL` | silent | Console log level (file always logs) |

## Prerequisites

- **Node.js 20+** and **npm**
- **API key** from [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/)
- Optional: **poppler** (`brew install poppler`) for PDF reading
- Optional: **ripgrep** (`brew install ripgrep`) for faster search

## License

ISC

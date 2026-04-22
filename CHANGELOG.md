# Changelog

All notable changes to JARVIS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-22

First stable release of JARVIS.

### Added

- Provider-agnostic AI runtime (Anthropic Claude + OpenAI-compatible models)
- Electron HUD with real-time SSE streaming, draggable/resizable panels
- Core node graph visualization with status transitions
- EventBus architecture — typed channels for piece communication
- Plugin system with hot-loading, esbuild renderer compilation, `context.md` injection
- MCP (Model Context Protocol) integration for external services
- Actor pool — persistent autonomous AI agents with memory and custom role system (`~/.jarvis/roles/*.md`)
- Skill system — extensible procedural knowledge loaded on demand (`~/.jarvis/skills/`)
- Diff viewer with interactive accept/reject and tab management
- Session persistence and archive with conversation restore on restart
- Context compaction — hybrid Engine A (API-native `compact-2026-01-12`) + Engine B (manual summarization fallback)
- gRPC server for external client integration
- Cron scheduler for recurring and one-shot prompts
- Chat panel with streaming, tool execution bars, abort, and compaction banners
- Token counter with real-time usage ring and model display
- Slash command registry for skills and plugins
- `jarvis_eval` — live runtime introspection inside the running JARVIS process
- Session inspector tools (system prompt, tools, messages, history)
- HUD layout persistence to settings
- Plugin renderer ErrorBoundary — crashed panels show error instead of black screen
- esbuild banner exports `createElement` directly for plugin renderers
- Functional test suite (BDD scenarios)

### Plugins (first-party)

- **[jarvis-plugin-actors](https://github.com/giovanibarili/jarvis-plugin-actors)** — actor pool with persistent memory and role dispatch
- **[jarvis-plugin-skills](https://github.com/giovanibarili/jarvis-plugin-skills)** — skill system with per-session isolation and token budgets
- **[jarvis-plugin-tasks](https://github.com/giovanibarili/jarvis-plugin-tasks)** — in-memory task management with dependency tracking and live HUD panel

### Infrastructure

- `@jarvis/core` v0.1.0 — stable public API for plugins (types, bus channels, compatibility contract)
- Plugin marketplace documentation (`MARKETPLACE.md`)
- CODEOWNERS for repo governance
- GitFlow with `release/x.y` branches and `vx.y.z` tags

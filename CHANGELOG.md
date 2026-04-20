# Changelog

All notable changes to JARVIS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-19

### Added
- **Plugin renderer ErrorBoundary** — crashed plugin panels show an error message instead of taking down the entire HUD (black screen prevention)
- **esbuild banner exports `createElement` directly** — plugin renderers using `createElement()` calls (not JSX) no longer get "createElement is not defined" errors
- **Tasks plugin** — in-memory task management with dependency tracking, tree-view HUD panel, progress bar, filter chips, session tags, and system context injection ([jarvis-plugin-tasks](https://github.com/giovanibarili/jarvis-plugin-tasks))
- 2 new BDD scenarios for ErrorBoundary and createElement banner

### Fixed
- Plugin renderers that call `createElement()` directly now work (banner was only exporting `__jarvis_jsx`)

## [0.1.0] - 2026-04-19

Initial release — establishing GitFlow and versioning baseline.

### Added
- Provider-agnostic AI runtime (Anthropic Claude + OpenAI-compatible models)
- Electron HUD with real-time SSE streaming, draggable/resizable panels
- Core node graph visualization with status transitions
- EventBus architecture — typed channels for piece communication
- Plugin system with hot-loading, esbuild renderer compilation, context.md injection
- MCP (Model Context Protocol) integration for external services
- Actor pool — persistent autonomous AI agents with memory and role system
- Skill system — extensible procedural knowledge loaded on demand
- Canvas plugin — Mermaid diagrams and freeform drawing with send-to-AI
- Diff viewer with interactive accept/reject and tab management
- Session persistence and archive with conversation restore on restart
- Context compaction — hybrid Engine A (API-native) + Engine B (manual fallback)
- gRPC server for external client integration
- Cron scheduler for recurring and one-shot prompts
- Chat panel with streaming, tool execution bars, abort, and compaction banners
- Token counter with real-time usage ring and model display
- Custom actor roles from `~/.jarvis/roles/*.md`
- Slash command registry for skills and plugins
- `jarvis_eval` for live runtime introspection
- Session inspector tools (system prompt, tools, messages)
- HUD layout persistence to settings
- Theme system foundation
- Functional test suite (BDD scenarios)

### Infrastructure
- `@jarvis/core` v2.0.0 — stable public API for plugins (types, bus, compatibility)
- Plugin marketplace documentation (MARKETPLACE.md)
- CODEOWNERS for repo governance

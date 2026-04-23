# Changelog

All notable changes to JARVIS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-23

### Added

- **Choice Prompt** — new `jarvis_ask_choice` capability. The AI can ask the user to pick between options via an inline chat card (radio / checkbox, optional "Other" free-text). Answer arrives as the next user message formatted as `[choice] <question> → <value(s)>`. Backed by a new `ChoicePromptPiece` and rehydratable from session history via `parseMessagesToHistory`.
- **Model-aware max output tokens** — new `getMaxOutput(model)` in `config/index.ts`. Opus → 128k, Sonnet/Haiku → 64k, unknown → 16k safe default. Replaces the hardcoded `max_tokens: 8192` in streaming and compaction calls.
- Regression tests:
  - `config/max-output.test.ts` — pins per-model output caps.
  - `ai/anthropic/session-tool-dedup.test.ts` — guards against duplicate `tool_use` ids in message history.
- Functional-test scenarios for the full Choice Prompt flow (single, multi, "Other", history rehydration, suppressed capability entry).

### Fixed

- **Duplicate `tool_use` id crash on long Opus runs.** `streamFromAPI` pushed the assistant `message.content` (with `tool_use` blocks) whenever `stop_reason !== "tool_use"`, and `addToolResults` pushed a reconstructed assistant message with the same ids. When Opus returned a mixed `text + tool_use` response with `stop_reason: "end_turn"`, both pushes fired and the next API call failed with HTTP 400 `tool_use ids must be unique`. Now `streamFromAPI` always pushes `message.content` (unless compaction replaced history) and `addToolResults` only appends the user `tool_result` message.
- **`write_file` / `bash` mid-stream JSON truncation.** The 8192 `max_tokens` cap truncated large tool_use `input` JSON mid-stream, leading to `command is required` / `content is required` errors. Streaming and beta compaction now use `getMaxOutput(model)`.
- Compaction summary call bumped from 4096 → 8192 `max_tokens` (summaries are short prose but were occasionally clipped).

## [0.1.1] - 2026-04-22

### Fixed

- ESC key now correctly aborts only the focused chat session. The global `keydown` handler in `App.tsx` was always calling `/chat/abort` (main session), even when an actor chat panel was open — silently killing the main session mid-stream. `ChatPanel` already handles ESC per-panel via `abortUrl`, so the global handler was redundant and destructive.

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

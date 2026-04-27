# Changelog

All notable changes to JARVIS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-04-27

### Added

- **Pending prompt queue surfaced in the UI.** When the user sends additional messages while a turn is still busy, the backend already queued them in `JarvisCore.pendingPrompts`. Now `JarvisCore.broadcastPendingQueue(sessionId)` publishes a snapshot over `ai.stream` as `event: "pending_queue"` carrying `{ items: [{ text, source, hasImages }] }` (text truncated to 280 chars). Triggered on enqueue, on drain, and on session reset (idle transition emits an empty array). `ChatPiece` forwards it to the SSE stream as `{ type: "pending_queue", items, source, session }`. The event is intentionally not added to the public `AIStreamMessage` union to keep the type surface stable for plugins; `ChatPiece` reads it via cast.
- **`ChatPanel` renders queued user messages** as faint dashed cards directly under the thinking indicator, with a pulsing dot and a paperclip indicator when `hasImages` is true. They become real user messages once the backend drains the queue. Buffer cleared on session change and on `session_cleared`.
- **Sticky-bottom scroll in `ChatTimeline`.** Track distance from bottom on scroll; auto-scroll only while sticky (within 32px). If the user scrolled up to read older messages, new content streams silently without yanking the viewport. Exception: a freshly-arrived user message ALWAYS snaps to bottom, because sending a new message implies wanting to see the answer.

### Changed

- **Choice cards are now buffered until the turn settles.** `ChatPanel` accumulates `kind: "choice"` entries in a ref while the assistant is still streaming, and flushes them on `done` / `error` / `aborted`. Result: the card always lands at the very bottom of the assistant turn, never injected mid-stream. Streaming text is no longer cleared when a choice arrives — the model can keep talking and the card lands after the final text. Edge case: if neither streaming nor thinking is active when the choice arrives (deferred capability outside a normal turn), the card is flushed immediately. `isStreamingRef` / `isThinkingRef` mirror state so the SSE callback (closes over initial state) reads live values.

### Fixed

- **Anthropic compaction: sanitize `compaction` blocks from message history.** Engine A (API-native `compact-2026-01-12`) returns content with a `compaction`-typed block that is valid as API OUTPUT but rejected as INPUT on the next request, causing every post-compaction turn to fail with HTTP 400. Filter `compaction` blocks before storing the assistant message in `this.messages`. If filtering leaves no blocks, fall back to a synthetic text block carrying the compaction summary so the session never ends up with empty content.

## [0.2.2] - 2026-04-26

### Added

- **Per-session usage metrics** in the Anthropic HUD. `AnthropicMetricsHud` now buckets input/output/cache tokens, request count and per-request history (ring buffer, last 25) by `sessionId`. A new "scope" pill on top of the HUD lets the user pick `ALL` (aggregate, default) or any individual session (`main`, `actor-*`, `grpc-*`). Buckets are evicted when the session closes.
- **`AnthropicSession.emitAnthropicUsage()`** publishes `system.event` with `event: "api.anthropic.usage"` and `data.sessionId` after every API response. This is the primary telemetry channel for Anthropic going forward; the generic `api.usage` (published by `JarvisCore`) remains for backcompat.
- **`AISessionFactory.setBus?(bus)`** optional method on the public factory contract. `ProviderRouter` now plumbs the EventBus into the active provider's factory after activation, so factory-created sessions can publish provider-specific telemetry. Implemented for Anthropic; other providers may opt in.
- **`SessionManager.setBus(bus)`** + `session.closed` event. Every `close()` and `closeAll()` now emits `system.event { event: "session.closed", data: { sessionId } }` so downstream pieces (metrics HUDs, plugins) can evict per-session state. Wired up in `main.ts` immediately after construction.
- **`/providers/anthropic/scope` HTTP endpoints**: `POST` (`{ scope: string }`) switches the HUD scope, `GET` returns `{ provider, scope, available[] }`. Used by `TokenCounterRenderer` for the scope dropdown.
- **`SlashCommandContext`** new exported type from `capabilities/registry`. Slash command handlers now receive `(args, ctx?: { sessionId? })`. `ChatPiece` plumbs `ctx.sessionId` from whoever typed the slash.

### Changed

- **`/compact` is now session-aware.** The slash handler reads `ctx.sessionId` and acts on the calling session (`main`, `actor-*`, etc) instead of hardcoded `"main"`. `ChatPiece` broadcasts the system message and ai.stream `compaction` event back to the originating session. `sessions.save(sessionId)` correctly skips ephemeral sessions.
- **`jarvis_ask_choice` description rewritten** to be more imperative: forbids dumping options as plain text, lists explicit triggers (do you want A or B / which one / confirm-cancel / pick N), and tells the LLM to stop and call the tool when about to type `1) ... 2) ... which?`. Goal: stop the model from "asking with markdown bullets" instead of using the choice card.
- **`jarvis-system.md` rewritten for brevity** — same rules and architecture, denser prose, shorter sentences, less filler. Net −83 lines.

## [0.2.1] - 2026-04-24

### Added

- **Choice Prompt — multi-question cards.** `jarvis_ask_choice` now accepts `{ questions: [{ question, options, multi?, allow_other? }, ...] }` in addition to the legacy single-question shape. Renders one inline card with all questions and a single Confirm. Answer comes back as `[choice]\n<q1> → <a1>\n<q2> → <a2>\n...`. History rehydration (`parseMessagesToHistory`) now uses a FIFO queue so multiple pending choices don't overwrite each other, and label-to-value mapping uses greedy longest-match so labels containing `, ` (e.g. `"C) Card único, 1 submit final"`) parse correctly.
- **MCP Manager — config change detection on refresh.** `mcp_refresh` now detects CHANGED server configs (not just added/removed), disconnects the old client, replaces the in-memory config, and auto-reconnects when the server was previously connected or has `autoConnect: true`. Returns `Added: / Updated: / Removed:` in the tool output. Exposed `configsEqual(a, b)` with order-insensitive key comparison (args keep meaningful order).
- **MCP Manager — canonical config path.** `McpManager` now defaults to `~/.jarvis/mcp.json` instead of `<cwd>/mcp.json`. Constructor override still works for tests and custom setups.
- Unit tests: `src/input/chat-piece.test.ts` (10 tests covering single/multi choice parsing, greedy label match, queue ordering) and `src/mcp/manager.test.ts` (14 tests covering `configsEqual` semantics and refresh diff behavior).
- Functional-test scenarios for MCP Manager (canonical path, add/remove/update refresh, no-op on whitespace change, autoConnect flip) and multi-question choice cards.

### Changed

- `ChoicePromptData` SSE payload now carries `questions: ChoiceQuestion[]` as the primary shape; legacy `question` / `options` / `multi` / `allow_other` fields remain for backward-compatibility with older frontends.
- `ChatTimeline` choice card: one card renders all questions, single Confirm submits all answers at once; `onChoiceSubmit(index, answers[])` replaces the old `(index, values, otherText)` signature. Legacy single-question entries from persisted history still render via a normalization shim.
- `ChatPanel` publishes a single `ai.request` with the multi-line `[choice]` format when multiple questions are answered.

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

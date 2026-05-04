# Changelog

All notable changes to JARVIS will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-02

### Changed

- **Release 0.3 open.** Starting new iteration.

---

## [0.2.7] - 2026-05-02

### Fixed

- **Actor sessions no longer inherit JARVIS identity.** `buildCustomSystemBlocks` previously injected `jarvis-system.md` (full JARVIS persona + Asimov's laws) and `getInstructions()` (CLAUDE.md, 236 lines) into every actor session, with `actor-system.md` appended afterward in `<IMPORTANT>`. The LLM read ~10k chars of "you are JARVIS" before reaching "you are NOT JARVIS", causing actors to adopt the JARVIS persona and address the user as "Sir". Fix: when `basePromptOverride` is set (actor sessions), the custom prompt IS the entire base — `jarvis-system.md`, CLAUDE.md, `coreContexts`, and `pluginInstructions` are all excluded. Actor prompt is now: `actor-system.md` + `roleContext` + per-session plugin context (skills).
- **`actor-system.md` rewritten** with clear actor identity, `session_info` reference for self-discovery, and corrected `bus_publish` channel format (`ai.request`).

## [0.2.6] - 2026-04-27

### Changed

- **`ChatPiece` is now plugin-agnostic.** It no longer mirrors `type:"user"` for any session — owned or not. The session OWNER (JarvisCore for `main`/`grpc-*`, or any plugin owning custom sessionIds like `actor-*`) is the single authority responsible for emitting `prompt_dispatched` (timeline) and `pending_queue` (queue cards). The frontend just renders whatever SSE delivers. Symmetric contract: `actor-*` now behaves exactly like `main` — message goes to the queue card while pending, migrates to a `type:"user"` timeline entry at the moment of dispatch.

### Fixed

- **Visual duplication on plugin-owned sessions when busy.** PR #37 (0.2.5) made `ChatPiece` mirror `type:"user"` immediately on `/chat/send` for non-core sessions, which collided with `actor-runner.broadcastPendingQueue`: a message arriving while the actor was processing showed up simultaneously in the timeline AND in the QUEUED card. Fix: remove the mirror entirely; let the plugin emit `prompt_dispatched` only when the message is actually dispatched to the model (idle path or queue drain). Pending messages now appear ONLY in the QUEUED card, and migrate to the timeline at the moment of dispatch — same UX as `main`.

### Deprecated

- **`ChatPiece.setOwnedSessionMatcher(fn)`** is now a no-op kept for backward compat. Will be removed in 0.3.0. The matcher is no longer needed because ChatPiece is fully agnostic to session ownership.

### Plugin compat

- **`jarvis-plugin-actors` ≥ 2.1.1** restores `broadcastPromptDispatched` (idle path + `handleDispatch` + `drainQueue`). Without this, actor sessions will lose their timeline entries entirely. Earlier versions of the plugin work but only via the now-removed mirror — they need updating before this JARVIS release.

## [0.2.5] - 2026-04-27

### Fixed

- **Anthropic: sanitize orphan `tool_use` without matching `tool_result`.** `sanitizeMessages` already covered the inverse case (orphan `tool_result` without preceding `tool_use`), but missed assistant messages ending in `tool_use` blocks whose ids are not satisfied by the next message — exactly what happens after an interrupted tool call (process restart, abort that did not run `cleanupAbortedTools`, crash mid-execution) followed by a fresh user prompt. Real-world repro: `actor-jarvis-brain` session got stuck after a `jarvis_eval` was interrupted; every subsequent prompt failed with HTTP 400 `tool_use ids were found without tool_result blocks immediately after`. New second pass injects a synthetic `user` turn with placeholder `tool_result` blocks (`is_error: true`) for every orphan id, mirroring the shape `cleanupAbortedTools` produces. Idempotent — running it again adds nothing. Auto-applied on every session restore (`SessionManager.restore() → factory.create({ restoreMessages }) → setMessages → sanitizeMessages`), so historical sessions self-heal on the next boot. PR #36.
- **Chat: mirror `type:"user"` immediately for plugin-owned sessions.** Commit `ca11a57` (0.2.4) made `ChatPiece` stop broadcasting `type:"user"` on POST `/chat/send` and rely on `JarvisCore.broadcastPromptDispatched` to emit the timeline entry at the moment the prompt is actually sent. This fixed duplication for sessions JarvisCore owns (`main`, `grpc-*`) but broke sessions owned by plugins — notably `actor-*` sessions managed by `jarvis-plugin-actors`, which never receive `prompt_dispatched` because the actor-runner subscribes to `ai.request` directly. Symptom: user typed in an actor's `ChatPanel`, the message reached the actor (visible response) but never appeared in the panel timeline. `ChatPiece` now asks "is this session owned by JarvisCore?" via a matcher set at boot. Owned → don't mirror; JarvisCore handles it. Not owned → broadcast `type:"user"` immediately so the panel renders what the user typed. Safe default: matcher unset → mirror always (better than dropping input). PR #37.

### Added

- **`JarvisCore.isSessionOwned(sessionId)`** — public matcher exposing the existing `ownedPatterns` check (`main`, `grpc-*`, plus any plugin-registered patterns) so other pieces can decide whether to defer to JarvisCore for timeline mirroring.
- **`ChatPiece.setOwnedSessionMatcher(fn)`** — boot-time wiring so ChatPiece can route `type:"user"` broadcasts conditionally based on session ownership.

## [0.2.4] - 2026-04-27

### Changed

- **Timeline reflects what was sent to the API; pending queue reflects what is waiting.** Previously, every `ai.request` was mirrored as a `type:"user"` SSE on arrival, so a message from an actor (or any non-chat source) appeared in the chat timeline AND simultaneously as a queued card under the thinking indicator — a visual duplication. The new rule:
  - **Timeline (`type:"user"`)** materializes only when the prompt is actually about to be sent to the AI. JarvisCore emits a new internal event `prompt_dispatched` at that moment, and ChatPiece translates it into the SSE `type:"user"` event.
  - **Pending queue (`type:"pending_queue"`)** continues to show whatever is sitting in `pendingPrompts` for the session.
  - A queue drain emits **one `prompt_dispatched` per originally-queued message**, so each shows up as its own user entry with its preserved source label (chat / actor-* / grpc / etc.). The backend still combines them into a single API call to save tokens.
- Slash command flow unchanged — slash commands never go through `ai.request`, so they still broadcast `type:"user"` immediately.

### Added

- **`JarvisCore.broadcastPromptDispatched(sessionId, items[])`** — internal helper that emits an `ai.stream` event `prompt_dispatched` carrying `items: [{ text, source, images? }]`. Like `pending_queue`, it is intentionally NOT in the public `AIStreamMessage.event` union (kept off the type surface so plugins do not need to update); ChatPiece reads it via cast.
- **`JarvisCore.dispatchToSession(sessionId, text, images)`** — extracted from `handlePrompt` so `drainQueue` can ship the combined prompt without re-running the queue branch and without re-emitting `prompt_dispatched`.

### Fixed

- **Visual duplication of actor / non-chat messages.** When an actor published `ai.request` while JARVIS was busy, the message rendered both as a user entry in the timeline and as a queued card under the thinking indicator. With the new dispatch semantics, a queued message shows ONLY as a queued card until it is actually sent, then transitions into a user entry.

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

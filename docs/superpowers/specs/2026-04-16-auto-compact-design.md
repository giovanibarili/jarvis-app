# Auto-Compact — Hybrid Context Compaction

**Date:** 2026-04-16
**Status:** Approved
**Model:** claude-opus-4-6 (1M context)

## Problem

JARVIS accumulates message history across turns. Each API request resends the full history, and without compaction long sessions will hit the 1M context limit and cost scales linearly with history size. After a bootstrap session with 35 messages and 74 API requests, the session consumed 7.2M cumulative input tokens at only ~3% context usage — extrapolating to a full work session, costs and context overflow become inevitable.

## Solution

Hybrid auto-compact with two engines:

- **Engine A (API Native):** Uses the Anthropic compaction beta (`compact-2026-01-12`) via `client.beta.messages.stream()` with `context_management` parameter. The API handles summarization, thrashing detection, and streaming natively. Primary path.
- **Engine B (Fallback Manual):** If Engine A fails or doesn't trigger and tokens exceed 95% of max context, JARVIS sends a separate summarization request, replaces the message history with the summary, and continues. Safety net only.

## Architecture

Compact lives as a layer inside `AnthropicSession`, not as a separate piece. Decision is automatic — Engine A always, Engine B only if A fails or doesn't fire.

### Flow

```
Request normal
  │
  ├─ streamFromAPI() adds context_management to request
  │
  ├─ Response has compaction block?
  │   ├─ YES → Engine A fired
  │   │   ├─ stop_reason === "compaction" → pause
  │   │   ├─ Emit bus event: system.event { event: "compaction", engine: "api" }
  │   │   ├─ Chat shows notification: "Context compacted — X → Y tokens"
  │   │   ├─ Store compaction block in messages array
  │   │   └─ Next user interaction continues normally
  │   │
  │   └─ NO → No compaction this turn
  │       ├─ Check: input_tokens > 95% of maxContext?
  │       │   ├─ YES → Engine B (fallback)
  │       │   │   ├─ Send summarization request (same model)
  │       │   │   ├─ Replace messages[] with summary as user message
  │       │   │   ├─ Emit bus event: system.event { event: "compaction", engine: "fallback" }
  │       │   │   └─ Chat shows notification with "fallback" badge
  │       │   └─ NO → Normal operation
  │       └─ done
  │
  └─ Beta header error?
      └─ Log warning, retry without beta (graceful degradation)
          └─ Next requests retry beta after 5-min cooldown
```

### Engine A — API Native

Uses `client.beta.messages.stream()` with:

```typescript
{
  betas: ["compact-2026-01-12"],
  model, max_tokens, system, messages, tools,
  context_management: {
    edits: [{
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: threshold },
      pause_after_compaction: true,
      instructions: customInstructions
    }]
  }
}
```

Response includes `compaction` content blocks and `iterations` array in usage for billing accuracy.

### Engine B — Fallback Manual

Triggered when Engine A is unavailable or context exceeds 95% without API compaction:

1. Count current tokens (from last `usage.input_tokens`)
2. Send a summarization request with the full message history
3. Replace `messages[]` with a single user message containing the summary
4. Continue normally

Anti-thrashing: max 2 consecutive fallback attempts. If context is still above 95% after fallback, emit warning to chat and stop trying.

## Settings

New `compaction` block in `settings.json` / `settings.user.json`:

```json
{
  "compaction": {
    "enabled": true,
    "thresholdPercent": 83.5,
    "instructions": "Preserve capability names, tool call results, actor pool state, code snippets, and design decisions. Summarize verbose tool outputs and intermediate reasoning. Keep track of what the user asked for and current progress.",
    "pauseAfterCompaction": true
  }
}
```

- `enabled` — kill switch, disables both engines
- `thresholdPercent` — percentage of model's maxContext. Default 83.5% (matches Claude Code). Engine A uses this as absolute token value. Engine B uses 95% as safety net.
- `instructions` — custom summarization prompt, used by both engines
- `pauseAfterCompaction` — if true, stop_reason "compaction" pauses for user notification; if false, API continues transparently

`maxContext` derived from model: Opus = 1M, Haiku/Sonnet = 200K (already exists in metrics-hud `getMaxContext()`).

## File Changes

### `session.ts` (core change)
- `streamFromAPI()` switches to `client.beta.messages.stream()` with beta header and `context_management`
- Detects `compaction` blocks in response content
- Emits new `AIStreamEvent` type `"compaction"`
- Handles `stop_reason: "compaction"` (pause, don't add to messages as normal turn)
- Fallback: if beta fails, retry without it + 5-min cooldown flag
- Engine B: after each response without compaction, check if `input_tokens > 95% * maxContext`, trigger manual summarization if so

### `types.ts`
- `AIStreamEvent` gains `type: "compaction"` with `{ summary, engine, tokensBefore, tokensAfter }`
- New `CompactionConfig` interface for settings

### `metrics-hud.ts`
- Listens for `"compaction"` event on bus
- Adds `compactionCount` and `lastCompactionEngine` to `getData()`

### `settings.ts`
- New `compaction` block in settings schema with defaults

### `factory.ts`
- Exposes `getMaxContext()` (currently private in metrics-hud) so session can calculate absolute threshold

### `jarvis.ts` (JarvisCore)
- Handles new `stop_reason: "compaction"`: emits bus event, shows chat notification
- Does NOT enter `waiting_tools`, just pauses and waits for next user input

### `chat-piece.ts`
- Renders compaction notification in chat timeline

### `ChatOutput.tsx` (HUD)
- New `ChatEntry` kind: `{ kind: 'compaction', engine, tokensBefore, tokensAfter, summary }`
- Blue/cyan banner with compression icon, expandable to show full summary

## Chat UX

Compaction notification in the unified timeline:

```
🗜 Context compacted — 835K → 28K tokens (API)
```

Fallback variant:

```
🗜 Context compacted — 950K → 32K tokens (fallback)
```

Expandable: clicking shows the full summary the summarizer generated.

## Edge Cases

- **Beta unavailable:** Graceful degradation to `client.messages.stream()` (no compaction), retry beta after 5-min cooldown
- **Thrashing (Engine B):** Max 2 consecutive fallback attempts. After that, emit warning: "Context too large even after compaction — consider starting a new session"
- **Mid-tool-loop:** Compact only fires between complete turns (when state is idle). Engine A handles this natively. Engine B only checks after turn completion.
- **Actor sessions:** Each actor session compacts independently with the same global config. Actor compaction doesn't affect main session.
- **OpenAI provider:** No changes. Compaction is Anthropic-only. Future OpenAI support is a separate scope.

## Billing Impact

Engine A: response includes `usage.iterations` array. Total cost = sum of all iterations (compaction + message). Top-level `input_tokens`/`output_tokens` only count non-compaction iterations.

Engine B: the summarization request is a separate API call billed normally.

Both engines reduce subsequent request costs by shrinking the message history.

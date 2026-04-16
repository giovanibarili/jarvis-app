# Auto-Compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hybrid context compaction to JARVIS — API-native (Engine A) with manual fallback (Engine B) — so long sessions auto-summarize when approaching the context limit.

**Architecture:** Engine A uses the Anthropic `compact-2026-01-12` beta with `context_management` and `pause_after_compaction: true`. Engine B activates when Engine A is unavailable or fails, performing manual summarization via a separate API call. Settings are user-configurable. The chat shows a notification banner when compaction occurs.

**Tech Stack:** `@anthropic-ai/sdk` ^0.88.0, TypeScript, Anthropic Beta Messages API, React (HUD)

---

### Task 1: Add CompactionConfig to Settings

**Files:**
- Modify: `app/src/core/settings.ts`
- Modify: `app/.jarvis/settings.json`

- [ ] **Step 1: Add CompactionSettings interface and merge logic**

In `app/src/core/settings.ts`, add the interface and update the Settings type:

```typescript
export interface CompactionSettings {
  enabled: boolean;
  thresholdPercent: number;
  instructions: string;
  pauseAfterCompaction: boolean;
}
```

Add to the `Settings` interface:

```typescript
export interface Settings {
  pieces: Record<string, PieceSettings & { config?: PieceConfig }>;
  plugins?: Record<string, PluginSettings>;
  providers?: Record<string, ProviderSettings>;
  model?: string;
  compaction?: CompactionSettings;
}
```

Update `deepMerge` to include compaction:

```typescript
function deepMerge(base: Settings, override: Settings): Settings {
  return {
    pieces: { ...base.pieces, ...override.pieces },
    plugins: { ...base.plugins, ...override.plugins },
    providers: { ...base.providers, ...override.providers },
    model: override.model ?? base.model,
    compaction: override.compaction
      ? { ...DEFAULT_COMPACTION, ...base.compaction, ...override.compaction }
      : base.compaction,
  };
}
```

Add the defaults constant (above `deepMerge`):

```typescript
const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  thresholdPercent: 83.5,
  instructions: "Preserve capability names, tool call results, actor pool state, code snippets, and design decisions. Summarize verbose tool outputs and intermediate reasoning. Keep track of what the user asked for and current progress.",
  pauseAfterCompaction: true,
};
```

Add a getter function:

```typescript
export function getCompactionSettings(settings: Settings): CompactionSettings {
  return { ...DEFAULT_COMPACTION, ...settings.compaction };
}
```

- [ ] **Step 2: Add compaction defaults to settings.json**

In `app/.jarvis/settings.json`, add the compaction block at the top level alongside existing keys:

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

- [ ] **Step 3: Commit**

```bash
git add app/src/core/settings.ts app/.jarvis/settings.json
git commit -m "feat(settings): add compaction config with defaults"
```

---

### Task 2: Expose getMaxContext from Config

**Files:**
- Modify: `app/src/config/index.ts`

The metrics-hud currently has a private `getMaxContext()`. We need this in session.ts for threshold calculation. Add it to config as the single source of truth.

- [ ] **Step 1: Add getMaxContext to config**

In `app/src/config/index.ts`, add after the `getCurrentProvider` function:

```typescript
export function getMaxContext(model?: string): number {
  const m = model ?? config.model;
  if (m.includes("opus")) return 1_000_000;
  if (m.includes("haiku")) return 200_000;
  return 200_000; // sonnet and others
}
```

- [ ] **Step 2: Update metrics-hud to use shared getMaxContext**

In `app/src/ai/anthropic/metrics-hud.ts`, replace the private `getMaxContext` method:

Remove:
```typescript
  private getMaxContext(): number {
    const model = config.model;
    if (model.includes("opus")) return 1000000;
    if (model.includes("haiku")) return 200000;
    return 200000;
  }
```

Add import at top:
```typescript
import { getMaxContext } from "../../config/index.js";
```

Replace all `this.getMaxContext()` calls with `getMaxContext()` (there are 2 in `getData()`).

- [ ] **Step 3: Commit**

```bash
git add app/src/config/index.ts app/src/ai/anthropic/metrics-hud.ts
git commit -m "refactor: extract getMaxContext to shared config"
```

---

### Task 3: Add Compaction Types to AIStreamEvent

**Files:**
- Modify: `app/src/ai/types.ts`
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add compaction event to AIStreamEvent**

In `app/src/ai/types.ts`, update the `AIStreamEvent` interface:

```typescript
export interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error' | 'compaction';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'compaction';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  error?: string;
  compaction?: {
    summary: string;
    engine: 'api' | 'fallback';
    tokensBefore: number;
    tokensAfter: number;
  };
}
```

- [ ] **Step 2: Add compaction event to AIStreamMessage in core types**

In `packages/core/src/types.ts`, update `AIStreamMessage`:

```typescript
export interface AIStreamMessage extends BusMessage {
  channel: "ai.stream";
  event: "delta" | "complete" | "error" | "tool_start" | "tool_done" | "tool_cancelled" | "aborted" | "compaction";
  text?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  toolName?: string;
  toolId?: string;
  toolMs?: number;
  toolArgs?: string;
  toolOutput?: string;
  compaction?: {
    summary: string;
    engine: 'api' | 'fallback';
    tokensBefore: number;
    tokensAfter: number;
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/ai/types.ts packages/core/src/types.ts
git commit -m "feat(types): add compaction event to AIStreamEvent and AIStreamMessage"
```

---

### Task 4: Implement Engine A — API Native Compaction in AnthropicSession

**Files:**
- Modify: `app/src/ai/anthropic/session.ts`

This is the core change. The `streamFromAPI()` method switches to `client.beta.messages.stream()` with compaction support.

- [ ] **Step 1: Add compaction config and beta cooldown state**

Add imports and state at the top of `AnthropicSession`:

```typescript
import { load as loadSettings, getCompactionSettings } from "../../core/settings.js";
import { getMaxContext } from "../../config/index.js";
```

Add private fields after the existing ones:

```typescript
  private betaDisabledUntil = 0; // timestamp — cooldown after beta failure
  private static BETA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
```

- [ ] **Step 2: Add helper to build compaction config**

Add a private method after the constructor:

```typescript
  private getCompactionConfig(): {
    useBeta: boolean;
    contextManagement?: Record<string, unknown>;
    betas?: string[];
  } {
    const settings = getCompactionSettings(loadSettings());
    if (!settings.enabled) return { useBeta: false };

    const now = Date.now();
    if (now < this.betaDisabledUntil) {
      log.debug({ label: this.label, cooldownRemaining: this.betaDisabledUntil - now }, "AnthropicSession: beta on cooldown");
      return { useBeta: false };
    }

    const maxCtx = getMaxContext();
    const threshold = Math.max(50_000, Math.floor(maxCtx * settings.thresholdPercent / 100));

    return {
      useBeta: true,
      betas: ["compact-2026-01-12"],
      contextManagement: {
        edits: [{
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: threshold },
          pause_after_compaction: settings.pauseAfterCompaction,
          ...(settings.instructions ? { instructions: settings.instructions } : {}),
        }],
      },
    };
  }
```

- [ ] **Step 3: Refactor streamFromAPI to use beta with fallback**

Replace the entire `streamFromAPI` method. The key changes:
1. Try `client.beta.messages.stream()` when beta is enabled
2. Detect compaction blocks in response
3. Fall back to `client.messages.stream()` on beta error
4. Emit compaction events

```typescript
  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    const rawTools = this.getTools();
    const toolNames = rawTools.map((t: any) => t.name);

    const msgSummary = this.messages.map((m, i) => {
      const role = m.role;
      if (typeof m.content === "string") return { i, role, type: "text", length: m.content.length };
      if (Array.isArray(m.content)) return { i, role, blocks: m.content.map((b: any) => ({ type: b.type, ...(b.type === "tool_use" ? { name: b.name } : {}), ...(b.type === "tool_result" ? { tool_use_id: b.tool_use_id, contentType: typeof b.content === "string" ? "string" : Array.isArray(b.content) ? `array[${b.content.length}]` : typeof b.content } : {}) })) };
      return { i, role };
    });
    log.info({ label: this.label, messageCount: this.messages.length, toolCount: toolNames.length, tools: toolNames, messages: msgSummary }, "AnthropicSession: calling API");

    const tools: Anthropic.Tool[] | undefined = rawTools.length > 0
      ? rawTools.map((t, i) => ({
          ...t,
          ...(i === rawTools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        })) as Anthropic.Tool[]
      : undefined;

    const compactionCfg = this.getCompactionConfig();

    try {
      this.abortController = new AbortController();

      let message: any;

      if (compactionCfg.useBeta) {
        try {
          const stream = (this.client.beta.messages as any).stream({
            betas: compactionCfg.betas,
            model: this.getModel(),
            max_tokens: 8192,
            system: this.getSystemPrompt(),
            messages: this.messages,
            tools,
            context_management: compactionCfg.contextManagement,
          }, { signal: this.abortController.signal });

          stream.on("text", () => {}); // ensure text events are consumed
          message = await stream.finalMessage();
        } catch (betaErr: any) {
          // If beta-specific error, fall back to non-beta
          if (betaErr?.status === 400 || betaErr?.message?.includes("beta") || betaErr?.message?.includes("compact")) {
            log.warn({ label: this.label, err: betaErr.message }, "AnthropicSession: beta failed, falling back to standard API");
            this.betaDisabledUntil = Date.now() + AnthropicSession.BETA_COOLDOWN_MS;
            // Fall through to non-beta path below
            message = null;
          } else {
            throw betaErr; // non-beta error, propagate
          }
        }
      }

      if (!message) {
        // Non-beta path (either beta disabled or failed)
        const stream = this.client.messages.stream({
          model: this.getModel(),
          max_tokens: 8192,
          system: this.getSystemPrompt(),
          messages: this.messages,
          tools,
        }, { signal: this.abortController.signal });

        stream.on("text", () => {});
        message = await stream.finalMessage();
      }

      // Process response content
      const toolCalls: CapabilityCall[] = [];
      let fullText = "";
      let compactionSummary: string | undefined;

      for (const block of message.content) {
        if (block.type === "text") {
          fullText += block.text;
        } else if (block.type === "tool_use") {
          const tc: CapabilityCall = { id: block.id, name: block.name, input: block.input as Record<string, unknown> };
          toolCalls.push(tc);
        } else if (block.type === "compaction") {
          compactionSummary = (block as any).content;
          log.info({ label: this.label, summaryLength: compactionSummary!.length }, "AnthropicSession: compaction block received (Engine A)");
        }
      }

      if (fullText) {
        yield { type: "text_delta", text: fullText };
      }

      for (const tc of toolCalls) {
        yield { type: "tool_use", toolUse: tc };
      }

      // Handle compaction — emit event with before/after token counts
      if (compactionSummary) {
        const tokensBefore = (message.usage as any)?.iterations?.[0]?.input_tokens ?? message.usage?.input_tokens ?? 0;
        const tokensAfter = message.usage?.input_tokens ?? 0;

        // Store compaction block in messages for subsequent requests
        this.messages = [{ role: "assistant", content: message.content }];

        yield {
          type: "compaction",
          compaction: {
            summary: compactionSummary,
            engine: "api",
            tokensBefore,
            tokensAfter,
          },
        };
      }

      if (message.stop_reason !== "tool_use" && message.stop_reason !== "compaction" && !compactionSummary) {
        this.messages.push({ role: "assistant", content: message.content });
      }

      // Build usage — sum iterations if available
      const iterations = (message.usage as any)?.iterations;
      const usage = message.usage ? {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: (message.usage as any).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: (message.usage as any).cache_read_input_tokens ?? 0,
        ...(iterations ? { iterations } : {}),
      } : undefined;

      yield {
        type: "message_complete",
        stopReason: message.stop_reason as AIStreamEvent["stopReason"],
        usage,
      };

      log.info({
        label: this.label,
        ms: Date.now() - t0,
        stopReason: message.stop_reason,
        toolCalls: toolCalls.length,
        toolCallNames: toolCalls.map(tc => tc.name),
        textLength: fullText.length,
        textPreview: fullText.slice(0, 300),
        compacted: !!compactionSummary,
        usage,
      }, "AnthropicSession: API call complete");

      this.abortController = undefined;

    } catch (err) {
      if (this.abortController?.signal.aborted) {
        log.info({ label: this.label }, "AnthropicSession: stream aborted");
        yield { type: "error", error: "aborted" };
        return;
      }
      log.error({ label: this.label, err }, "AnthropicSession: API error");
      yield { type: "error", error: String(err) };
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add app/src/ai/anthropic/session.ts
git commit -m "feat(session): implement Engine A — API native compaction with beta fallback"
```

---

### Task 5: Implement Engine B — Manual Fallback Compaction

**Files:**
- Modify: `app/src/ai/anthropic/session.ts`

Engine B triggers after a normal (non-beta) response when `input_tokens > 95% * maxContext`. It sends a separate summarization request and replaces the message history.

- [ ] **Step 1: Add fallback compaction method and counter**

Add a private field for thrashing protection:

```typescript
  private consecutiveFallbacks = 0;
  private static MAX_CONSECUTIVE_FALLBACKS = 2;
```

Add the fallback method after `getCompactionConfig()`:

```typescript
  private async *fallbackCompact(lastInputTokens: number): AsyncGenerator<AIStreamEvent, void> {
    const settings = getCompactionSettings(loadSettings());
    if (!settings.enabled) return;

    const maxCtx = getMaxContext();
    const safetyThreshold = Math.floor(maxCtx * 0.95);

    if (lastInputTokens < safetyThreshold) {
      this.consecutiveFallbacks = 0;
      return;
    }

    if (this.consecutiveFallbacks >= AnthropicSession.MAX_CONSECUTIVE_FALLBACKS) {
      log.warn({ label: this.label, consecutiveFallbacks: this.consecutiveFallbacks }, "AnthropicSession: max fallback attempts reached, skipping");
      yield {
        type: "compaction",
        compaction: {
          summary: "Context too large even after compaction — consider starting a new session.",
          engine: "fallback",
          tokensBefore: lastInputTokens,
          tokensAfter: lastInputTokens,
        },
      };
      return;
    }

    this.consecutiveFallbacks++;
    const tokensBefore = lastInputTokens;

    log.info({ label: this.label, tokensBefore, threshold: safetyThreshold }, "AnthropicSession: Engine B fallback compaction triggered");

    const instructions = settings.instructions ||
      "Summarize this conversation preserving key decisions, code, and progress.";

    try {
      const summaryResponse = await this.client.messages.create({
        model: this.getModel(),
        max_tokens: 4096,
        system: `You are a conversation summarizer. ${instructions}
Wrap your summary in <summary></summary> tags.`,
        messages: this.messages,
      });

      const summaryText = summaryResponse.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");

      // Extract content between <summary> tags, or use full text
      const match = summaryText.match(/<summary>([\s\S]*?)<\/summary>/);
      const summary = match ? match[1].trim() : summaryText.trim();

      // Replace message history with summary
      this.messages = [
        { role: "user", content: `[Previous conversation summary]\n\n${summary}` },
        { role: "assistant", content: "Understood. I have the context from our previous conversation. How would you like to proceed?" },
      ];

      const tokensAfter = Math.ceil(summary.length / 4); // rough estimate

      log.info({ label: this.label, tokensBefore, tokensAfterEstimate: tokensAfter, summaryLength: summary.length }, "AnthropicSession: Engine B compaction complete");

      yield {
        type: "compaction",
        compaction: {
          summary,
          engine: "fallback",
          tokensBefore,
          tokensAfter,
        },
      };
    } catch (err) {
      log.error({ label: this.label, err }, "AnthropicSession: Engine B fallback compaction failed");
    }
  }
```

- [ ] **Step 2: Wire fallback into streamFromAPI**

After the `yield message_complete` event in `streamFromAPI()`, before the final log, add the Engine B check:

```typescript
      // Engine B: check if fallback compaction needed (only if Engine A didn't trigger)
      if (!compactionSummary && usage) {
        const totalInput = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        yield* this.fallbackCompact(totalInput);
      }
```

- [ ] **Step 3: Commit**

```bash
git add app/src/ai/anthropic/session.ts
git commit -m "feat(session): implement Engine B — manual fallback compaction"
```

---

### Task 6: Handle Compaction in JarvisCore

**Files:**
- Modify: `app/src/core/jarvis.ts`

JarvisCore's `consumeStream` needs to handle the new `compaction` event — emit it on the bus and update state.

- [ ] **Step 1: Add compaction case to consumeStream**

In the `switch (event.type)` block inside `consumeStream()`, add a new case after `"message_complete"`:

```typescript
        case "compaction":
          if (event.compaction) {
            this.bus.publish({
              channel: "ai.stream",
              source: "jarvis-core",
              target: sessionId,
              event: "compaction",
              compaction: event.compaction,
            } as any);

            this.bus.publish({
              channel: "system.event",
              source: "jarvis-core",
              event: "compaction",
              data: {
                sessionId,
                engine: event.compaction.engine,
                tokensBefore: event.compaction.tokensBefore,
                tokensAfter: event.compaction.tokensAfter,
                summaryLength: event.compaction.summary.length,
              },
            });

            log.info({
              sessionId,
              engine: event.compaction.engine,
              tokensBefore: event.compaction.tokensBefore,
              tokensAfter: event.compaction.tokensAfter,
            }, "JarvisCore: context compacted");
          }
          break;
```

- [ ] **Step 2: Commit**

```bash
git add app/src/core/jarvis.ts
git commit -m "feat(core): handle compaction events in JarvisCore consumeStream"
```

---

### Task 7: Add Compaction to Chat Notifications

**Files:**
- Modify: `app/src/input/chat-piece.ts`

ChatPiece needs to forward the compaction event to SSE clients so the HUD can display it.

- [ ] **Step 1: Add compaction case to ai.stream handler**

In the `switch (msg.event)` block in `chat-piece.ts`, add after the `"aborted"` case:

```typescript
        case "compaction":
          this.broadcast({
            type: "compaction",
            engine: (msg as any).compaction?.engine,
            tokensBefore: (msg as any).compaction?.tokensBefore,
            tokensAfter: (msg as any).compaction?.tokensAfter,
            summary: (msg as any).compaction?.summary,
            source,
            session: msg.target,
          });
          break;
```

- [ ] **Step 2: Commit**

```bash
git add app/src/input/chat-piece.ts
git commit -m "feat(chat): forward compaction events to SSE clients"
```

---

### Task 8: Render Compaction Banner in HUD

**Files:**
- Modify: `app/ui/src/components/panels/ChatTimeline.tsx`
- Modify: `app/ui/src/components/panels/ChatOutput.tsx`

- [ ] **Step 1: Add compaction kind to ChatEntry union**

In `ChatTimeline.tsx`, update the `ChatEntry` type:

```typescript
export type ChatEntry =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; images?: ChatImage[]; source?: string; session?: string; aborted?: boolean }
  | { kind: 'capability'; name: string; id: string; args?: string; status: 'running' | 'done' | 'cancelled'; ms?: number; output?: string; expanded?: boolean }
  | { kind: 'compaction'; engine: 'api' | 'fallback'; tokensBefore: number; tokensAfter: number; summary: string; expanded?: boolean }
```

- [ ] **Step 2: Add compaction rendering in ChatTimeline**

In the `entries.map` callback, after the `entry.kind === 'capability'` block and before the `return null`, add:

```typescript
        if (entry.kind === 'compaction') {
          const beforeK = Math.round(entry.tokensBefore / 1000)
          const afterK = Math.round(entry.tokensAfter / 1000)
          const badge = entry.engine === 'fallback' ? ' (fallback)' : ''
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: entry.expanded ? '4px 4px 0 0' : '4px',
                  fontSize: '10px',
                  borderLeft: '3px solid #8be9fd',
                  background: '#1a1e2e',
                  color: '#8be9fd',
                  cursor: 'pointer',
                }}
                onClick={() => onToggleExpand(i)}
              >
                🗜 Context compacted — {beforeK}K → {afterK}K tokens{badge}
                <span style={{ marginLeft: '4px', opacity: 0.5 }}>{entry.expanded ? '▾' : '▸'}</span>
              </div>
              {entry.expanded && (
                <div style={{
                  padding: '4px 8px 4px 14px',
                  background: '#111420',
                  borderLeft: '3px solid #333',
                  borderRadius: '0 0 4px 4px',
                  fontSize: '9px',
                  color: '#888',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '200px',
                  overflowY: 'auto',
                  lineHeight: '1.4',
                }}>
                  {entry.summary}
                </div>
              )}
            </div>
          )
        }
```

- [ ] **Step 3: Handle compaction event in ChatOutput**

In `ChatOutput.tsx`, add a case in the `source.onmessage` switch, after `"aborted"`:

```typescript
        case 'compaction':
          setIsThinking(false)
          setIsStreaming(false)
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session }])
            }
            return ''
          })
          setEntries(prev => [...prev, {
            kind: 'compaction',
            engine: data.engine ?? 'api',
            tokensBefore: data.tokensBefore ?? 0,
            tokensAfter: data.tokensAfter ?? 0,
            summary: data.summary ?? '',
          }])
          break
```

- [ ] **Step 4: Update toggleExpand to support compaction entries**

In `ChatOutput.tsx`, update the `toggleExpand` callback to handle both capability and compaction:

```typescript
  const toggleExpand = useCallback((index: number) => {
    setEntries(prev => prev.map((e, j) => {
      if (j !== index) return e
      if (e.kind === 'capability') return { ...e, expanded: !e.expanded }
      if (e.kind === 'compaction') return { ...e, expanded: !e.expanded }
      return e
    }))
  }, [])
```

- [ ] **Step 5: Commit**

```bash
git add app/ui/src/components/panels/ChatTimeline.tsx app/ui/src/components/panels/ChatOutput.tsx
git commit -m "feat(hud): render compaction banner in chat timeline"
```

---

### Task 9: Update Metrics HUD for Compaction Tracking

**Files:**
- Modify: `app/src/ai/anthropic/metrics-hud.ts`

- [ ] **Step 1: Add compaction counters and event listener**

Add private fields:

```typescript
  private compactionCount = 0;
  private lastCompactionEngine: string | null = null;
```

In the `start()` method, add a second subscriber after the existing `api.usage` one:

```typescript
    this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "compaction") return;
      this.compactionCount++;
      this.lastCompactionEngine = (msg.data.engine as string) ?? null;
      log.info({ count: this.compactionCount, engine: this.lastCompactionEngine }, "AnthropicMetrics: compaction recorded");

      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: this.getData(),
        status: "running",
      });
    });
```

Note: store the unsubscribe handle. Change the existing `private unsub?: () => void;` to:

```typescript
  private unsubs: Array<() => void> = [];
```

Update `start()` to push both subscribes:

```typescript
    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "api.usage") return;
      // ... existing api.usage handler
    }));

    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "compaction") return;
      // ... new compaction handler above
    }));
```

Update `stop()`:

```typescript
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
```

- [ ] **Step 2: Add compaction data to getData()**

In `getData()`, add to the returned object:

```typescript
      compactionCount: this.compactionCount,
      lastCompactionEngine: this.lastCompactionEngine,
```

- [ ] **Step 3: Commit**

```bash
git add app/src/ai/anthropic/metrics-hud.ts
git commit -m "feat(metrics): track compaction count and engine in HUD"
```

---

### Task 10: Integration Test — Manual Validation

**Files:** None (manual testing)

- [ ] **Step 1: Start JARVIS and verify no errors**

```bash
cd ~/dev/personal/jarvis-app/app
set -a; source .env; set +a
npx tsx src/main.ts
```

Verify in logs:
- No errors about beta header or compaction
- `AnthropicSessionFactory: initialized` appears
- `AnthropicMetricsHud: started` appears

- [ ] **Step 2: Send a message and verify beta path is active**

Send a message via gRPC:
```bash
npx tsx src/transport/grpc/client.ts localhost:50051 "hello"
```

Check logs for:
- `AnthropicSession: calling API` with normal output
- No beta errors

- [ ] **Step 3: Verify compaction settings via jarvis_eval**

```bash
npx tsx src/transport/grpc/client.ts localhost:50051 'Use jarvis_eval with this code:

const { getCompactionSettings } = await import("./core/settings.js");
const { load } = await import("./core/settings.js");
return JSON.stringify(getCompactionSettings(load()), null, 2);'
```

Expected: compaction settings with defaults.

- [ ] **Step 4: Verify metrics include compaction fields**

```bash
npx tsx src/transport/grpc/client.ts localhost:50051 'Use jarvis_eval with this code:

const provider = providerRouter.getActiveProvider();
const data = provider.metricsPiece.getData();
return JSON.stringify({ compactionCount: data.compactionCount, lastCompactionEngine: data.lastCompactionEngine }, null, 2);'
```

Expected: `{ "compactionCount": 0, "lastCompactionEngine": null }`

- [ ] **Step 5: Commit all remaining changes (if any)**

```bash
git status
# If clean, skip. Otherwise:
git add -A && git commit -m "chore: final adjustments from integration testing"
```

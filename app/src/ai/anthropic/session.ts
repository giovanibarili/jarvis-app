// src/ai/anthropic/session.ts
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AIStreamEvent, CapabilityCall, CapabilityResult, ImageBlock } from "../types.js";
import type { EventBus } from "../../core/bus.js";
import { log } from "../../logger/index.js";
import { config } from "../../config/index.js";
import { cleanupAbortedToolMessages } from "./cleanup-aborted-tools.js";
import { sanitizeMessages } from "./sanitize-messages.js";
import { load as loadSettings, getCompactionSettings } from "../../core/settings.js";
import { getMaxContext, getMaxOutput } from "../../config/index.js";

type CapabilityDef = { name: string; description: string; input_schema: Record<string, unknown> };
type SystemPrompt = string | TextBlockParam[];

/** Total number of retries on transient errors before giving up. */
export const MAX_RETRIES = 10;

/**
 * Classify an error from the Anthropic SDK or underlying HTTP/network stack.
 * Returns a short reason string if the error is transient (retryable),
 * or null if it should propagate immediately.
 *
 * Retryable cases:
 *   - 529 overloaded_error  (provider sobrecarregado)
 *   - 503 service_unavailable
 *   - 502 bad_gateway
 *   - 500 api_error
 *   - 429 rate_limit_error
 *   - Network errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, ENOTFOUND, EPIPE
 *   - APIConnectionError / APIConnectionTimeoutError from the SDK
 *
 * Non-retryable cases (caller must surface):
 *   - 400 invalid_request_error  (our payload is broken — retry won't fix it)
 *   - 401 / 403 authentication_error / permission_error
 *   - 404 not_found_error
 *   - any "Could not process image" (handled separately upstream)
 *   - User abort (handled separately upstream)
 */
export function classifyTransientError(err: any): string | null {
  if (!err) return null;
  const status: number | undefined = err?.status ?? err?.response?.status;
  const apiType: string | undefined = err?.error?.type ?? err?.error?.error?.type;
  const code: string | undefined = err?.code ?? err?.cause?.code;
  const name: string | undefined = err?.name ?? err?.constructor?.name;
  const msg = String(err?.message ?? err ?? "");

  // SDK-typed connection errors
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") {
    return name;
  }

  // Status-based classification
  if (status === 529) return "overloaded_error (529)";
  if (status === 503) return "service_unavailable (503)";
  if (status === 502) return "bad_gateway (502)";
  if (status === 500) return "api_error (500)";
  if (status === 429) return "rate_limit_error (429)";

  // Anthropic error type field
  if (apiType === "overloaded_error") return "overloaded_error";
  if (apiType === "rate_limit_error") return "rate_limit_error";
  if (apiType === "api_error") return "api_error";

  // Node network errors
  const NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);
  if (code && NET_CODES.has(code)) return code;
  for (const c of NET_CODES) {
    if (msg.includes(c)) return c;
  }

  // Loose message-based fallback for overloaded_error (defensive — Anthropic
  // sometimes returns it with status undefined when streaming)
  if (msg.includes("overloaded_error") || msg.includes('"type":"overloaded_error"')) {
    return "overloaded_error";
  }

  return null;
}

/**
 * Sleep for `ms`, but resolve early if the abort signal fires. Returns true
 * if the sleep was aborted, false if it completed normally.
 */
export function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AnthropicSession implements AISession {
  readonly sessionId: string;
  private client: Anthropic;
  private getModel: () => string;
  private getSystemPrompt: () => SystemPrompt;
  private getTools: () => CapabilityDef[];
  private messages: MessageParam[] = [];
  private label: string;
  private abortController?: AbortController;
  private contextInjector?: () => Array<{ role: "user"; content: string; cache_control?: { type: "ephemeral" } }>;
  private bus?: EventBus;
  private betaDisabledUntil = 0;
  private static BETA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  private consecutiveFallbacks = 0;
  private static MAX_CONSECUTIVE_FALLBACKS = 2;
  /**
   * Counts retries within a single streamFromAPI invocation chain. Reset
   * to 0 on successful completion or when retries are exhausted, so a
   * subsequent user prompt always gets a fresh budget.
   */
  private retryAttempt = 0;

  constructor(opts: {
    client: Anthropic;
    model: string | (() => string);
    systemPrompt: string | (() => SystemPrompt);
    getTools: () => CapabilityDef[];
    label: string;
    bus?: EventBus;
  }) {
    this.sessionId = crypto.randomUUID();
    this.client = opts.client;
    const model = opts.model;
    this.getModel = typeof model === "function" ? model : () => model;
    this.getSystemPrompt = typeof opts.systemPrompt === "function"
      ? opts.systemPrompt
      : () => opts.systemPrompt as SystemPrompt;
    this.getTools = opts.getTools;
    this.label = opts.label;
    this.bus = opts.bus;
    log.info({ label: this.label, sessionId: this.sessionId }, "AnthropicSession: created");
  }

  /**
   * Publish Anthropic-specific usage telemetry keyed by sessionId (= this.label).
   * Consumed by AnthropicMetricsHud which buckets metrics per session.
   * Emits on every API response that carries a `message.usage` payload.
   */
  private emitAnthropicUsage(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }): void {
    if (!this.bus) return;
    this.bus.publish({
      channel: "system.event",
      source: "anthropic-session",
      event: "api.anthropic.usage",
      data: {
        sessionId: this.label,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        model: config.model,
      },
    });
  }

  setContextInjector(injector: () => Array<{ role: "user"; content: string; cache_control?: { type: "ephemeral" } }>): void {
    this.contextInjector = injector;
  }

  async *sendAndStream(prompt: string, images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void> {
    // Inject message-mode context (e.g. skills with injection: message)
    this.injectEphemeralContext();

    if (images && images.length > 0) {
      const content: ContentBlockParam[] = [];
      for (const img of images) {
        content.push({
          type: "image" as any,
          source: { type: "base64", media_type: img.mediaType, data: img.base64 },
        } as any);
        content.push({ type: "text", text: `[${img.label}]` });
      }
      content.push({ type: "text", text: prompt });
      this.messages.push({ role: "user", content });
    } else {
      this.messages.push({ role: "user", content: prompt });
    }
    yield* this.streamFromAPI();
  }

  addToolResults(toolCalls: CapabilityCall[], results: CapabilityResult[]): void {
    log.info({
      label: this.label,
      toolCalls: toolCalls.map(tc => tc.name),
      results: results.map(r => ({
        id: r.tool_use_id,
        contentType: typeof r.content === 'string' ? 'string' : Array.isArray(r.content) ? `array[${r.content.length}]` : typeof r.content,
        isError: r.is_error,
        preview: typeof r.content === 'string' ? r.content.slice(0, 100) : JSON.stringify(r.content).slice(0, 100),
      })),
    }, "AnthropicSession: addToolResults");

    // NOTE: We do NOT push an assistant tool_use message here.
    // The assistant message (including any tool_use blocks) is already pushed
    // by streamFromAPI with the original message.content preserved.
    // Rebuilding tool_use blocks here would create duplicate IDs in history
    // whenever the API returns a mixed response (text + tool_use) with a
    // stop_reason that allows the streamFromAPI push to happen.

    const toolResultBlocks: ToolResultBlockParam[] = results.map(r => ({
      type: "tool_result" as const,
      tool_use_id: r.tool_use_id,
      content: r.content as ToolResultBlockParam["content"],
      is_error: r.is_error,
    }));
    this.messages.push({ role: "user", content: toolResultBlocks });
  }

  async *continueAndStream(): AsyncGenerator<AIStreamEvent, void> {
    yield* this.streamFromAPI();
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      // Don't clear abortController here — streamFromAPI catch needs to check .signal.aborted
      // It gets cleared at the end of streamFromAPI after successful completion
      log.info({ label: this.label }, "AnthropicSession: aborted");
    }
  }

  cleanupAbortedTools(pendingCalls: CapabilityCall[]): void {
    this.messages = cleanupAbortedToolMessages(this.messages, pendingCalls);
    log.info(
      { label: this.label, messageCount: this.messages.length },
      "AnthropicSession: cleaned up aborted tools",
    );
  }

  close(): void {
    log.info({ label: this.label, messageCount: this.messages.length }, "AnthropicSession: closed");
    this.messages = [];
  }

  getMessages(): unknown[] {
    return this.messages;
  }

  setMessages(messages: unknown[]): void {
    this.messages = sanitizeMessages(messages as MessageParam[]);
    log.info(
      { label: this.label, restored: this.messages.length, original: messages.length },
      "AnthropicSession: messages restored",
    );
  }

  private getCompactionConfig(): {
    useBeta: boolean;
    betas?: string[];
    contextManagement?: Record<string, unknown>;
  } {
    const settings = getCompactionSettings(loadSettings());
    if (!settings.enabled || Date.now() < this.betaDisabledUntil) {
      return { useBeta: false };
    }
    const maxCtx = getMaxContext(this.getModel());
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

  /**
   * Force compaction (Engine B) regardless of token threshold.
   * Called by the /compact slash command. Skips threshold checks and
   * consecutive fallback guards — always runs if there are messages to compact.
   */
  async *forceCompact(): AsyncGenerator<AIStreamEvent, void> {
    if (this.messages.length === 0) return;

    const ctx = this.measureContext();
    const tokensBefore = ctx.totalTokensEst;

    log.info({ label: this.label, tokensBefore, messageCount: ctx.messageCount }, "AnthropicSession: forced compaction requested");

    yield* this.doCompact(tokensBefore);
  }

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

    log.info({ label: this.label, tokensBefore: lastInputTokens, threshold: safetyThreshold }, "AnthropicSession: Engine B fallback compaction triggered");

    yield* this.doCompact(lastInputTokens);
  }

  /**
   * Core compaction logic shared by both fallbackCompact and forceCompact.
   * Sends messages to a summarizer, replaces history with the summary.
   */
  private async *doCompact(tokensBefore: number): AsyncGenerator<AIStreamEvent, void> {
    const settings = getCompactionSettings(loadSettings());
    const instructions = settings.instructions ||
      "Summarize this conversation preserving key decisions, code, and progress.";

    try {
      // Ensure messages end with a user message (API requirement)
      const msgs = [...this.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
        msgs.push({ role: "user", content: "Please summarize the conversation above." });
      }

      const summaryResponse = await this.client.messages.create({
        model: this.getModel(),
        max_tokens: 8192, // summary is short prose, doesn't need the full output budget
        system: `You are a conversation summarizer. ${instructions}\nWrap your summary in <summary></summary> tags.`,
        messages: msgs,
      });

      const summaryText = summaryResponse.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");

      // Extract content between <summary> tags, or use full text
      const match = summaryText.match(/<summary>([\s\S]*?)<\/summary>/);
      const summary = match ? match[1].trim() : summaryText.trim();

      // Replace message history with summary
      this.injectedContextCount = 0; // compaction wipes all messages — reset ephemeral tracking
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
      log.error({ label: this.label, err }, "AnthropicSession: Engine B compaction failed");
    }
  }

  private measureContext(): { systemChars: number; messagesChars: number; messageCount: number; toolsChars: number; totalTokensEst: number } {
    // System prompt size
    const sys = this.getSystemPrompt();
    const systemChars = typeof sys === "string"
      ? sys.length
      : Array.isArray(sys)
        ? sys.reduce((sum, b) => sum + ((b as any).text?.length ?? 0), 0)
        : 0;

    // Messages size
    const messagesChars = this.messages.reduce((sum, m) => {
      if (typeof m.content === "string") return sum + m.content.length;
      if (Array.isArray(m.content)) return sum + m.content.reduce((s, b: any) => s + (b.text?.length ?? (b.input ? JSON.stringify(b.input).length : 0)), 0);
      return sum;
    }, 0);

    // Tools size
    const rawTools = this.getTools();
    const toolsChars = JSON.stringify(rawTools).length;

    return {
      systemChars,
      messagesChars,
      messageCount: this.messages.length,
      toolsChars,
      totalTokensEst: Math.ceil((systemChars + messagesChars + toolsChars) / 4),
    };
  }

  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    const rawTools = this.getTools();
    const toolNames = rawTools.map((t: any) => t.name);

    const ctx = this.measureContext();
    log.info({
      label: this.label,
      messageCount: ctx.messageCount,
      toolCount: toolNames.length,
      context: {
        systemChars: ctx.systemChars,
        messagesChars: ctx.messagesChars,
        toolsChars: ctx.toolsChars,
        totalTokensEst: ctx.totalTokensEst,
      },
    }, "AnthropicSession: calling API");

    // Detailed message structure only at debug level
    log.debug({ label: this.label, tools: toolNames, messages: this.messages.map((m, i) => {
      const role = m.role;
      if (typeof m.content === "string") return { i, role, type: "text", length: m.content.length };
      if (Array.isArray(m.content)) return { i, role, blocks: m.content.map((b: any) => ({ type: b.type, ...(b.type === "tool_use" ? { name: b.name } : {}), ...(b.type === "tool_result" ? { tool_use_id: b.tool_use_id } : {}) })) };
      return { i, role };
    }) }, "AnthropicSession: message structure");

    try {
      // Add cache_control (BP1) to the last tool definition
      const tools: Anthropic.Tool[] | undefined = rawTools.length > 0
        ? rawTools.map((t, i) => ({
            ...t,
            ...(i === rawTools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
          })) as Anthropic.Tool[]
        : undefined;

      this.abortController = new AbortController();

      const compactionConfig = this.getCompactionConfig();
      let message: any | undefined;

      // Engine A: try beta compaction API
      if (compactionConfig.useBeta) {
        try {
          log.info({ label: this.label, betas: compactionConfig.betas }, "AnthropicSession: attempting beta compaction API");
          const betaStream = (this.client.beta.messages as any).stream({
            model: this.getModel(),
            max_tokens: getMaxOutput(this.getModel()),
            system: this.getSystemPrompt(),
            messages: this.messages,
            tools,
            cache_control: { type: "ephemeral" as const },
            betas: compactionConfig.betas,
            context_management: compactionConfig.contextManagement,
          }, { signal: this.abortController.signal });

          betaStream.on("text", () => {});
          message = await betaStream.finalMessage();
        } catch (betaErr: any) {
          const status = betaErr?.status ?? betaErr?.response?.status;
          const errMsg = String(betaErr?.message ?? betaErr ?? "");
          const isNetworkError = /terminated|socket|ECONNRESET|ETIMEDOUT|other side closed/i.test(errMsg);
          const isBetaError = status === 400 || /beta|compact/i.test(errMsg) || isNetworkError;
          if (isBetaError) {
            log.warn({ label: this.label, status, err: errMsg }, "AnthropicSession: beta compaction failed, falling back to standard API");
            this.betaDisabledUntil = Date.now() + AnthropicSession.BETA_COOLDOWN_MS;
            message = undefined; // fall through to standard path
          } else {
            throw betaErr; // non-beta error, propagate
          }
        }
      }

      // Standard path (non-beta or beta fallback)
      if (!message) {
        const stream = this.client.messages.stream({
          model: this.getModel(),
          max_tokens: getMaxOutput(this.getModel()),
          system: this.getSystemPrompt(),
          messages: this.messages,
          tools,
          cache_control: { type: "ephemeral" as const },
        } as any, { signal: this.abortController.signal });

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
        }
      }

      // Yield text and tool_use events
      if (fullText) {
        yield { type: "text_delta", text: fullText };
      }
      for (const tc of toolCalls) {
        yield { type: "tool_use", toolUse: tc };
      }

      // Handle compaction
      if (compactionSummary) {
        const iterationsArr = (message.usage as any)?.iterations;
        const tokensBefore = iterationsArr?.[0]?.input_tokens ?? message.usage?.input_tokens ?? 0;
        const tokensAfter = message.usage?.input_tokens ?? 0;

        // Replace message history with compacted context.
        // CRITICAL: filter out 'compaction' blocks — they are valid in API
        // OUTPUT but rejected as INPUT (Anthropic API v2026-01-12). Keep only
        // text/tool_use blocks so subsequent turns don't fail with 400.
        this.injectedContextCount = 0; // compaction wipes all messages — reset ephemeral tracking
        const sanitized = (message.content as any[]).filter(b => b?.type !== "compaction");
        this.messages = sanitized.length > 0
          ? [{ role: "assistant", content: sanitized }]
          : [{ role: "assistant", content: [{ type: "text", text: `[Previous conversation compacted by Anthropic API]\n${compactionSummary}` }] }];

        yield {
          type: "compaction",
          compaction: {
            summary: compactionSummary,
            engine: "api",
            tokensBefore,
            tokensAfter,
          },
        };

        log.info({
          label: this.label,
          engine: "api",
          tokensBefore,
          tokensAfter,
          reduction: tokensBefore > 0 ? `${Math.round((1 - tokensAfter / tokensBefore) * 100)}%` : "N/A",
        }, "AnthropicSession: compaction applied");
      }

      // Push assistant message to history whenever there's content to preserve,
      // unless compaction already replaced the history above.
      // This includes stop_reason === "tool_use" (so the tool_use blocks are
      // persisted before addToolResults appends the matching tool_result).
      if (message.stop_reason !== "compaction" && !compactionSummary && message.content.length > 0) {
        this.messages.push({ role: "assistant", content: message.content });
      }

      const iterations = (message.usage as any)?.iterations;
      const usage = message.usage ? {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: (message.usage as any).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: (message.usage as any).cache_read_input_tokens ?? 0,
        ...(iterations ? { iterations } : {}),
      } : undefined;

      // Emit provider-specific, sessionId-scoped usage telemetry.
      // This is the primary channel for Anthropic metrics going forward;
      // the generic `api.usage` (published by JarvisCore) remains for backcompat.
      if (usage) this.emitAnthropicUsage(usage);

      yield {
        type: "message_complete",
        stopReason: message.stop_reason as AIStreamEvent["stopReason"],
        usage,
      };

      // Engine B: check if fallback compaction needed (only if Engine A didn't trigger)
      if (!compactionSummary && usage) {
        const totalInput = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        yield* this.fallbackCompact(totalInput);
      }

      const ctxAfter = this.measureContext();
      log.info({
        label: this.label,
        ms: Date.now() - t0,
        stopReason: message.stop_reason,
        toolCalls: toolCalls.length,
        toolCallNames: toolCalls.map(tc => tc.name),
        textLength: fullText.length,
        textPreview: fullText.slice(0, 300),
        usage,
        contextAfter: {
          messageCount: ctxAfter.messageCount,
          systemChars: ctxAfter.systemChars,
          messagesChars: ctxAfter.messagesChars,
          totalTokensEst: ctxAfter.totalTokensEst,
        },
      }, "AnthropicSession: API call complete");

      // Clean up ephemeral injected context so it doesn't persist in saved history
      this.removeInjectedContext();
      this.abortController = undefined;

    } catch (err: any) {
      if (this.abortController?.signal.aborted) {
        log.info({ label: this.label }, "AnthropicSession: stream aborted");
        yield { type: "error", error: "aborted" };
        return;
      }

      // Detect "Could not process image" errors and recover by stripping images
      const errMsg = String(err?.message ?? err ?? "");
      if (errMsg.includes("Could not process image")) {
        log.warn({ label: this.label }, "AnthropicSession: image processing error detected, stripping images from history and retrying");
        const stripped = this.stripImagesFromMessages();
        if (stripped > 0) {
          log.info({ label: this.label, strippedImages: stripped }, "AnthropicSession: images stripped, retrying API call");
          yield* this.streamFromAPI();
          return;
        }
        // If no images were found to strip, fall through to normal error
        log.warn({ label: this.label }, "AnthropicSession: no images found to strip despite image error");
      }

      // Transient errors → exponential backoff with jitter, up to 10 retries.
      // Examples: 529 overloaded_error, 503 service_unavailable, 502 bad_gateway,
      // 429 rate_limit_error, 500 api_error, network errors (ECONNRESET / ETIMEDOUT / EAI_AGAIN).
      const transient = classifyTransientError(err);
      if (transient && this.retryAttempt < MAX_RETRIES) {
        this.retryAttempt += 1;
        const baseDelayMs = 1000 * Math.pow(2, this.retryAttempt - 1); // 1s, 2s, 4s, ..., 512s
        // ±20% jitter
        const jitter = (Math.random() * 0.4 - 0.2) * baseDelayMs;
        const delayMs = Math.max(0, Math.round(baseDelayMs + jitter));
        log.warn({
          label: this.label,
          attempt: this.retryAttempt,
          maxAttempts: MAX_RETRIES,
          delayMs,
          reason: transient,
          err: errMsg,
        }, "AnthropicSession: transient error, retrying with backoff");
        yield {
          type: "retry",
          retry: {
            attempt: this.retryAttempt,
            maxAttempts: MAX_RETRIES,
            delayMs,
            reason: transient,
          },
        };
        // Sleep with abort awareness
        const aborted = await sleepInterruptible(delayMs, this.abortController?.signal);
        if (aborted) {
          log.info({ label: this.label }, "AnthropicSession: retry sleep aborted by user");
          yield { type: "error", error: "aborted" };
          return;
        }
        // Recurse — the retry counter ensures we cap at MAX_RETRIES total
        yield* this.streamFromAPI();
        return;
      }

      // Either non-transient or retries exhausted — surface as a real error.
      // Reset retry counter so a new user prompt can retry afresh.
      if (this.retryAttempt >= MAX_RETRIES) {
        log.error({ label: this.label, attempts: this.retryAttempt }, "AnthropicSession: retries exhausted");
      }
      this.retryAttempt = 0;
      log.error({ label: this.label, err }, "AnthropicSession: API error");
      yield { type: "error", error: String(err) };
      return;
    }

    // Successful run — reset retry counter so subsequent prompts start fresh
    this.retryAttempt = 0;
  }

  /**
   * Walk all messages and replace image blocks with a text placeholder.
   * Returns the number of images stripped.
   */
  /**
   * Inject ephemeral context from message-mode skills.
   * These are added as user messages right before the actual user prompt,
   * preserving system prompt cache. Ephemeral = removed after each API call
   * to avoid accumulating in history.
   */
  private injectedContextCount = 0;

  private injectEphemeralContext(): void {
    // Remove previously injected context messages (they're always at the end, before the new user message)
    this.removeInjectedContext();

    if (!this.contextInjector) return;
    const contexts = this.contextInjector();
    if (contexts.length === 0) return;

    for (const ctx of contexts) {
      this.messages.push({
        role: "user",
        content: [{ type: "text", text: ctx.content, ...(ctx.cache_control ? { cache_control: ctx.cache_control } : {}) }],
      } as any);
      // Anthropic requires alternating user/assistant — add a synthetic assistant ack
      this.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Understood." }],
      });
    }
    this.injectedContextCount = contexts.length * 2; // user + assistant pairs
    log.debug({ label: this.label, injected: contexts.length }, "AnthropicSession: ephemeral context injected");
  }

  private removeInjectedContext(): void {
    if (this.injectedContextCount > 0) {
      this.messages.splice(this.messages.length - this.injectedContextCount, this.injectedContextCount);
      this.injectedContextCount = 0;
    }
  }

  private stripImagesFromMessages(): number {
    let count = 0;
    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (let i = msg.content.length - 1; i >= 0; i--) {
        const block = msg.content[i] as any;
        if (block.type === "image") {
          msg.content.splice(i, 1, {
            type: "text",
            text: "[Image removed: could not be processed by API]",
          } as any);
          count++;
        }
      }
    }
    return count;
  }
}

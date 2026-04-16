// src/ai/anthropic/session.ts
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AIStreamEvent, CapabilityCall, CapabilityResult, ImageBlock } from "../types.js";
import { log } from "../../logger/index.js";
import { cleanupAbortedToolMessages } from "./cleanup-aborted-tools.js";
import { sanitizeMessages } from "./sanitize-messages.js";
import { load as loadSettings, getCompactionSettings } from "../../core/settings.js";
import { getMaxContext } from "../../config/index.js";

type CapabilityDef = { name: string; description: string; input_schema: Record<string, unknown> };
type SystemPrompt = string | TextBlockParam[];

export class AnthropicSession implements AISession {
  readonly sessionId: string;
  private client: Anthropic;
  private getModel: () => string;
  private getSystemPrompt: () => SystemPrompt;
  private getTools: () => CapabilityDef[];
  private messages: MessageParam[] = [];
  private label: string;
  private abortController?: AbortController;
  private betaDisabledUntil = 0;
  private static BETA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  private consecutiveFallbacks = 0;
  private static MAX_CONSECUTIVE_FALLBACKS = 2;

  constructor(opts: {
    client: Anthropic;
    model: string | (() => string);
    systemPrompt: string | (() => SystemPrompt);
    getTools: () => CapabilityDef[];
    label: string;
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
    log.info({ label: this.label, sessionId: this.sessionId }, "AnthropicSession: created");
  }

  async *sendAndStream(prompt: string, images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void> {
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
    const toolUseBlocks: ContentBlockParam[] = toolCalls.map(tc => ({
      type: "tool_use" as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
    this.messages.push({ role: "assistant", content: toolUseBlocks });

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
      this.abortController = undefined;
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
        system: `You are a conversation summarizer. ${instructions}\nWrap your summary in <summary></summary> tags.`,
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

  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    const rawTools = this.getTools();
    const toolNames = rawTools.map((t: any) => t.name);

    // Debug: log full message history structure
    const msgSummary = this.messages.map((m, i) => {
      const role = m.role;
      if (typeof m.content === "string") return { i, role, type: "text", length: m.content.length };
      if (Array.isArray(m.content)) return { i, role, blocks: m.content.map((b: any) => ({ type: b.type, ...(b.type === "tool_use" ? { name: b.name } : {}), ...(b.type === "tool_result" ? { tool_use_id: b.tool_use_id, contentType: typeof b.content === "string" ? "string" : Array.isArray(b.content) ? `array[${b.content.length}]` : typeof b.content } : {}) })) };
      return { i, role };
    });
    log.info({ label: this.label, messageCount: this.messages.length, toolCount: toolNames.length, tools: toolNames, messages: msgSummary }, "AnthropicSession: calling API");

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
            max_tokens: 8192,
            system: this.getSystemPrompt(),
            messages: this.messages,
            tools,
            betas: compactionConfig.betas,
            context_management: compactionConfig.contextManagement,
          }, { signal: this.abortController.signal });

          betaStream.on("text", () => {});
          message = await betaStream.finalMessage();
        } catch (betaErr: any) {
          const status = betaErr?.status ?? betaErr?.response?.status;
          const errMsg = String(betaErr?.message ?? betaErr ?? "");
          const isBetaError = status === 400 || /beta|compact/i.test(errMsg);
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

        // Replace message history with compacted context
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

        log.info({
          label: this.label,
          engine: "api",
          tokensBefore,
          tokensAfter,
          reduction: tokensBefore > 0 ? `${Math.round((1 - tokensAfter / tokensBefore) * 100)}%` : "N/A",
        }, "AnthropicSession: compaction applied");
      }

      // Push to message history only if not tool_use, not compaction stop, and no compaction happened
      if (message.stop_reason !== "tool_use" && message.stop_reason !== "compaction" && !compactionSummary) {
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

      log.info({
        label: this.label,
        ms: Date.now() - t0,
        stopReason: message.stop_reason,
        toolCalls: toolCalls.length,
        toolCallNames: toolCalls.map(tc => tc.name),
        textLength: fullText.length,
        textPreview: fullText.slice(0, 300),
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
}

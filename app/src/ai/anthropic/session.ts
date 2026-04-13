// src/ai/anthropic/session.ts
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AIStreamEvent, CapabilityCall, CapabilityResult, ImageBlock } from "../types.js";
import { log } from "../../logger/index.js";
import { cleanupAbortedToolMessages } from "./cleanup-aborted-tools.js";
import { sanitizeMessages } from "./sanitize-messages.js";

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
      const stream = this.client.messages.stream({
        model: this.getModel(),
        max_tokens: 8192,
        system: this.getSystemPrompt(),
        messages: this.messages,
        tools,
      }, { signal: this.abortController.signal });

      const toolCalls: CapabilityCall[] = [];
      let fullText = "";

      stream.on("text", (text) => {
        fullText += text;
      });

      const message = await stream.finalMessage();

      if (fullText) {
        yield { type: "text_delta", text: fullText };
      }

      for (const block of message.content) {
        if (block.type === "tool_use") {
          const tc: CapabilityCall = { id: block.id, name: block.name, input: block.input as Record<string, unknown> };
          toolCalls.push(tc);
          yield { type: "tool_use", toolUse: tc };
        }
      }

      if (message.stop_reason !== "tool_use") {
        this.messages.push({ role: "assistant", content: message.content });
      }

      const usage = message.usage ? {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: (message.usage as any).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: (message.usage as any).cache_read_input_tokens ?? 0,
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

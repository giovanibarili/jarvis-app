// src/ai/openai/session.ts
import OpenAI from "openai";
import type { AISession, AIStreamEvent, CapabilityCall, CapabilityResult, ImageBlock } from "../types.js";
import { log } from "../../logger/index.js";

type CapabilityDef = { name: string; description: string; input_schema: Record<string, unknown> };
type Message = OpenAI.Chat.ChatCompletionMessageParam;

export class OpenAISession implements AISession {
  readonly sessionId: string;
  private client: OpenAI;
  private getModel: () => string;
  private getSystemPrompt: () => string;
  private getTools: () => CapabilityDef[];
  private messages: Message[] = [];
  private label: string;
  private abortController?: AbortController;

  constructor(opts: {
    client: OpenAI;
    model: string | (() => string);
    systemPrompt: string | (() => string);
    getTools: () => CapabilityDef[];
    label: string;
  }) {
    this.sessionId = crypto.randomUUID();
    this.client = opts.client;
    const model = opts.model;
    this.getModel = typeof model === "function" ? model : () => model;
    const sp = opts.systemPrompt;
    this.getSystemPrompt = typeof sp === "function" ? sp : () => sp;
    this.getTools = opts.getTools;
    this.label = opts.label;
    log.info({ label: this.label, sessionId: this.sessionId }, "OpenAISession: created");
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
      log.info({ label: this.label }, "OpenAISession: aborted");
    }
  }

  async *sendAndStream(prompt: string, images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void> {
    if (images && images.length > 0) {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
      for (const img of images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        });
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
    // Add assistant message with tool calls
    this.messages.push({
      role: "assistant",
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    });
    // Add tool results
    for (const r of results) {
      this.messages.push({
        role: "tool",
        tool_call_id: r.tool_use_id,
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      });
    }
  }

  async *continueAndStream(): AsyncGenerator<AIStreamEvent, void> {
    yield* this.streamFromAPI();
  }

  close(): void {
    log.info({ label: this.label, messageCount: this.messages.length }, "OpenAISession: closed");
    this.messages = [];
  }

  getMessages(): unknown[] {
    return this.messages;
  }

  setMessages(messages: unknown[]): void {
    this.messages = messages as Message[];
    log.info({ label: this.label, restored: messages.length }, "OpenAISession: messages restored");
  }

  private toOpenAITools(): OpenAI.Chat.ChatCompletionTool[] {
    return this.getTools().map(t => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    this.abortController = new AbortController();

    const systemPrompt = this.getSystemPrompt();
    const tools = this.toOpenAITools();
    const model = this.getModel();

    log.info({ label: this.label, model, messageCount: this.messages.length, toolCount: tools.length }, "OpenAISession: calling API");

    try {
      const allMessages: Message[] = [
        { role: "system", content: systemPrompt },
        ...this.messages,
      ];

      const stream = await this.client.chat.completions.create({
        model,
        messages: allMessages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal: this.abortController.signal });

      const toolCalls: CapabilityCall[] = [];
      let fullText = "";
      let usage: { input_tokens: number; output_tokens: number } | undefined;

      // Track tool call assembly (streamed in pieces)
      const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          fullText += delta.content;
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls come in deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!pendingToolCalls.has(tc.index)) {
              pendingToolCalls.set(tc.index, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const pending = pendingToolCalls.get(tc.index)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
          }
        }

        // Usage in the final chunk
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
          };
        }
      }

      this.abortController = undefined;

      // Assemble completed tool calls
      for (const [, pending] of pendingToolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(pending.args); } catch {}
        const tc: CapabilityCall = { id: pending.id, name: pending.name, input };
        toolCalls.push(tc);
        yield { type: "tool_use", toolUse: tc };
      }

      // If no tool calls, save assistant message
      if (toolCalls.length === 0 && fullText) {
        this.messages.push({ role: "assistant", content: fullText });
      }

      yield {
        type: "message_complete",
        stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        usage: usage ? {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        } : undefined,
      };

      log.info({
        label: this.label,
        ms: Date.now() - t0,
        toolCalls: toolCalls.length,
        textLength: fullText.length,
        usage,
      }, "OpenAISession: API call complete");

    } catch (err) {
      this.abortController = undefined;
      if ((err as any)?.name === "AbortError") {
        log.info({ label: this.label }, "OpenAISession: stream aborted");
        yield { type: "error", error: "aborted" };
        return;
      }
      log.error({ label: this.label, err }, "OpenAISession: API error");
      yield { type: "error", error: String(err) };
    }
  }
}

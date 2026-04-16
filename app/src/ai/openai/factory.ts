// src/ai/openai/factory.ts
import OpenAI from "openai";
import type { AISession, AISessionFactory, CreateWithPromptOptions } from "../types.js";
import { OpenAISession } from "./session.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

type CapabilityDef = { name: string; description: string; input_schema: Record<string, unknown> };
type CapabilityProvider = () => CapabilityDef[];

export class OpenAISessionFactory implements AISessionFactory {
  private client: OpenAI;
  private getTools: CapabilityProvider;
  private getSystemPrompt: () => string;
  private sessionCounter = 0;

  constructor(
    getTools: CapabilityProvider,
    getSystemPrompt: () => string,
    clientOptions?: { apiKey?: string; baseURL?: string },
  ) {
    this.client = new OpenAI({
      apiKey: clientOptions?.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: clientOptions?.baseURL,
    });
    this.getTools = getTools;
    this.getSystemPrompt = getSystemPrompt;
    log.info({ model: config.model, baseURL: clientOptions?.baseURL ?? "default" }, "OpenAISessionFactory: initialized");
  }

  /** Create a session with optional overrides (for actors) */
  createWithPrompt(options: CreateWithPromptOptions): AISession {
    const { label, basePromptOverride, roleContext } = options;
    const basePrompt = this.getSystemPrompt();

    // Build full prompt: base + identity override + role context
    const parts: string[] = [basePrompt];
    if (basePromptOverride) {
      parts.push(`<IMPORTANT>\n${basePromptOverride}\n</IMPORTANT>`);
    }
    if (roleContext) {
      parts.push(roleContext);
    }
    const fullPrompt = parts.join("\n\n---\n\n");

    return new OpenAISession({
      client: this.client,
      model: () => config.model,
      systemPrompt: () => fullPrompt,
      getTools: this.getTools,
      label,
    });
  }

  create(options?: { label?: string; restoreMessages?: unknown[] }): AISession {
    const label = options?.label ?? `openai-${this.sessionCounter++}`;
    const session = new OpenAISession({
      client: this.client,
      model: () => config.model,
      systemPrompt: this.getSystemPrompt,
      getTools: this.getTools,
      label,
    });

    if (options?.restoreMessages && options.restoreMessages.length > 0) {
      session.setMessages(options.restoreMessages);
      log.info({ label, restored: options.restoreMessages.length }, "OpenAISessionFactory: restored messages into new session");
    }

    return session;
  }

  getToolDefinitions(): CapabilityDef[] {
    return this.getTools();
  }
}

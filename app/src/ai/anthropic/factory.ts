// src/ai/anthropic/factory.ts
import { readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AISessionFactory } from "../types.js";
import { AnthropicSession } from "./session.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

type CapabilityDef = { name: string; description: string; input_schema: Record<string, unknown> };
type CapabilityProvider = () => CapabilityDef[];

export class AnthropicSessionFactory implements AISessionFactory {
  private client: Anthropic;
  private basePrompt: string;
  private getTools: CapabilityProvider;
  private getCoreContext: () => string[];
  private getPluginContext: () => string[];
  private getInstructions: () => string;
  private sessionCounter = 0;

  constructor(
    getTools: CapabilityProvider,
    getCoreContext?: () => string[],
    getPluginContext?: () => string[],
    getInstructions?: () => string,
  ) {
    this.client = new Anthropic();
    this.basePrompt = this.loadBasePrompt();
    this.getTools = getTools;
    this.getCoreContext = getCoreContext ?? (() => []);
    this.getPluginContext = getPluginContext ?? (() => []);
    this.getInstructions = getInstructions ?? (() => "");
    log.info({ model: config.model, basePromptLength: this.basePrompt.length }, "AnthropicSessionFactory: initialized");
  }

  /** Build system blocks for actor sessions — same structure as main, with actor prompt prepended */
  private buildActorSystemBlocks(actorPrompt: string): TextBlockParam[] {
    const blocks: TextBlockParam[] = [];

    // Block 0: base system prompt + actor role prompt — BP1, always cached
    blocks.push({
      type: "text",
      text: this.basePrompt + "\n\n---\n\n" + actorPrompt,
      cache_control: { type: "ephemeral" },
    });

    // Block 1: core piece contexts — BP2
    const coreContexts = this.getCoreContext().filter(Boolean);
    if (coreContexts.length > 0) {
      blocks.push({
        type: "text",
        text: coreContexts.join("\n\n---\n\n"),
        cache_control: { type: "ephemeral" },
      });
    }

    // Block 2: user instructions (jarvis.md) — BP3
    const instructions = this.getInstructions();
    if (instructions) {
      blocks.push({
        type: "text",
        text: `<system-reminder>\n${instructions}\n</system-reminder>`,
        cache_control: { type: "ephemeral" },
      });
    }

    // Block 3: plugin contexts — BP4
    const pluginContexts = this.getPluginContext().filter(Boolean);
    if (pluginContexts.length > 0) {
      blocks.push({
        type: "text",
        text: pluginContexts.join("\n\n---\n\n"),
        cache_control: { type: "ephemeral" },
      });
    }

    return blocks;
  }

  /** Create a session with a custom system prompt (for actors — with prompt caching) */
  createWithPrompt(systemPrompt: string, options?: { label?: string }): AISession {
    const label = options?.label ?? `session-${this.sessionCounter++}`;
    const blockBuilder = () => this.buildActorSystemBlocks(systemPrompt);
    const estimatedLength = this.basePrompt.length + systemPrompt.length;
    log.debug({ label, estimatedPromptLength: estimatedLength }, "AnthropicSessionFactory: creating actor session with cache");
    return new AnthropicSession({
      client: this.client,
      model: () => config.model,
      systemPrompt: blockBuilder,
      getTools: this.getTools,
      label,
    });
  }

  getToolDefinitions(): CapabilityDef[] {
    return this.getTools();
  }

  /** Estimate token breakdown (1 token ≈ 4 chars) */
  getTokenBreakdown(): { systemTokens: number; toolsTokens: number } {
    const systemChars = this.buildSystemString().length;
    const toolsChars = JSON.stringify(this.getTools()).length;
    return {
      systemTokens: Math.ceil(systemChars / 4),
      toolsTokens: Math.ceil(toolsChars / 4),
    };
  }

  /** Build system prompt as TextBlockParam[] with cache breakpoints for main sessions */
  buildSystemBlocks(): TextBlockParam[] {
    const blocks: TextBlockParam[] = [];

    // Block 0: base prompt (jarvis-system.md) — always cached (static, never changes)
    blocks.push({ type: "text", text: this.basePrompt, cache_control: { type: "ephemeral" } });

    // Block 1: core piece contexts — BP2
    const coreContexts = this.getCoreContext().filter(Boolean);
    if (coreContexts.length > 0) {
      blocks.push({
        type: "text",
        text: coreContexts.join("\n\n---\n\n"),
        cache_control: { type: "ephemeral" },
      });
    }

    // Block 2: user instructions (jarvis.md) — BP3, cached with <system-reminder>
    const instructions = this.getInstructions();
    if (instructions) {
      blocks.push({
        type: "text",
        text: `<system-reminder>\n${instructions}\n</system-reminder>`,
        cache_control: { type: "ephemeral" },
      });
    }

    // Block 3: plugin contexts — BP4
    const pluginContexts = this.getPluginContext().filter(Boolean);
    if (pluginContexts.length > 0) {
      blocks.push({
        type: "text",
        text: pluginContexts.join("\n\n---\n\n"),
        cache_control: { type: "ephemeral" },
      });
    }

    return blocks;
  }

  create(options?: { label?: string; restoreMessages?: unknown[] }): AISession {
    const label = options?.label ?? `session-${this.sessionCounter++}`;
    log.debug({ label, contextBlocks: this.getCoreContext().length + this.getPluginContext().length }, "AnthropicSessionFactory: creating session");

    const session = new AnthropicSession({
      client: this.client,
      model: () => config.model,
      systemPrompt: () => this.buildSystemBlocks(),
      getTools: this.getTools,
      label,
    });

    if (options?.restoreMessages && options.restoreMessages.length > 0) {
      session.setMessages(options.restoreMessages);
      log.info({ label, restored: options.restoreMessages.length }, "AnthropicSessionFactory: restored messages into new session");
    }

    return session;
  }

  /** String version for token estimation */
  private buildSystemString(): string {
    const core = this.getCoreContext().filter(Boolean);
    const plugins = this.getPluginContext().filter(Boolean);
    const all = [...core, ...plugins];
    if (all.length === 0) return this.basePrompt;
    return this.basePrompt + "\n\n---\n\n" + all.join("\n\n---\n\n");
  }

  private loadBasePrompt(): string {
    const path = config.systemPromptPath;
    if (!existsSync(path)) {
      log.warn({ path }, "System prompt file not found, using default");
      return "You are JARVIS, an AI assistant created by Mr. Stark. Be helpful, concise, and precise. Address the user as Sir.";
    }
    const content = readFileSync(path, "utf-8");
    log.info({ path, size: content.length }, "System prompt loaded");
    return content;
  }
}

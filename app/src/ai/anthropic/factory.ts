// src/ai/anthropic/factory.ts
import { readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AISessionFactory, CreateWithPromptOptions } from "../types.js";
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

  /**
   * Build system blocks for actor sessions.
   * Same structure as main (buildSystemBlocks), but with:
   * - basePromptOverride wrapped in <IMPORTANT> after jarvis-system.md
   * - roleContext appended inside <system-reminder> after CLAUDE.md instructions
   * Consolidates into max 2 system blocks (BP2 + BP3) to stay within Anthropic's 4 cache_control limit.
   */
  private buildActorSystemBlocks(basePromptOverride?: string, roleContext?: string): TextBlockParam[] {
    const blocks: TextBlockParam[] = [];

    // Block 0 (BP2): base prompt + identity override + core contexts + instructions + role
    const parts: string[] = [this.basePrompt];

    if (basePromptOverride) {
      parts.push(`<IMPORTANT>\n${basePromptOverride}\n</IMPORTANT>`);
    }

    const coreContexts = this.getCoreContext().filter(Boolean);
    if (coreContexts.length > 0) {
      parts.push(coreContexts.join("\n\n---\n\n"));
    }

    const instructions = this.getInstructions();
    if (instructions || roleContext) {
      const reminderParts: string[] = [];
      if (instructions) reminderParts.push(instructions);
      if (roleContext) reminderParts.push(roleContext);
      parts.push(`<system-reminder>\n${reminderParts.join("\n\n")}\n</system-reminder>`);
    }

    blocks.push({
      type: "text",
      text: parts.join("\n\n---\n\n"),
      cache_control: { type: "ephemeral" },
    });

    // Block 1 (BP3): plugin contexts
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

  /** Create a session with optional overrides (for actors — with prompt caching) */
  createWithPrompt(options: CreateWithPromptOptions): AISession {
    const { label, basePromptOverride, roleContext } = options;
    const blockBuilder = () => this.buildActorSystemBlocks(basePromptOverride, roleContext);
    log.debug({ label, hasBaseOverride: !!basePromptOverride, hasRoleContext: !!roleContext }, "AnthropicSessionFactory: creating actor session with cache");
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

    // Block 0: base prompt + core contexts + instructions — single static cache breakpoint (BP1)
    // These never change during a session, so merging them saves cache overhead.
    const parts: string[] = [this.basePrompt];

    const coreContexts = this.getCoreContext().filter(Boolean);
    if (coreContexts.length > 0) {
      parts.push(coreContexts.join("\n\n---\n\n"));
    }

    const instructions = this.getInstructions();
    if (instructions) {
      parts.push(`<system-reminder>\n${instructions}\n</system-reminder>`);
    }

    blocks.push({
      type: "text",
      text: parts.join("\n\n---\n\n"),
      cache_control: { type: "ephemeral" },
    });

    // Block 1: plugin contexts — BP2 (may change when plugins are added/removed)
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

import type { CapabilityCall, CapabilityResult } from "./tools.js";

export interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string): AsyncGenerator<AIStreamEvent, void>;
  addToolResults(toolCalls: CapabilityCall[], results: CapabilityResult[]): void;
  continueAndStream(): AsyncGenerator<AIStreamEvent, void>;
  close(): void;
}

export interface CreateWithPromptOptions {
  label: string;
  /** Replaces the base system prompt (e.g. actor-system.md instead of jarvis-system.md) */
  basePromptOverride?: string;
  /** Extra context appended inside <system-reminder> after instructions (e.g. role prompt) */
  roleContext?: string;
}

export interface AISessionFactory {
  create(options?: { label?: string }): AISession;
  createWithPrompt(options: CreateWithPromptOptions): AISession;
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
}

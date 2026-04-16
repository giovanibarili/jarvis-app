// src/ai/types.ts

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

export type ToolResultContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

export interface CapabilityResult {
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

export interface CapabilityCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ImageBlock {
  label: string;
  base64: string;
  mediaType: string;
}

export interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string, images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void>;
  addToolResults(toolCalls: CapabilityCall[], results: CapabilityResult[]): void;
  continueAndStream(): AsyncGenerator<AIStreamEvent, void>;
  abort(): void;
  close(): void;
  /** Get raw message history for persistence */
  getMessages(): unknown[];
  /** Restore message history from persistence */
  setMessages(messages: unknown[]): void;
  /** Clean up message history after abort during waiting_tools */
  cleanupAbortedTools?(pendingCalls: CapabilityCall[]): void;
}

export interface CreateWithPromptOptions {
  label: string;
  /** Replaces the base system prompt (e.g. actor-system.md instead of jarvis-system.md) */
  basePromptOverride?: string;
  /** Extra context appended inside <system-reminder> after instructions (e.g. role prompt) */
  roleContext?: string;
}

export interface AISessionFactory {
  create(options?: { label?: string; restoreMessages?: unknown[] }): AISession;
  createWithPrompt(options: CreateWithPromptOptions): AISession;
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
}

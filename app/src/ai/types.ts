// src/ai/types.ts

export interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error' | 'compaction' | 'retry';
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
  /**
   * Emitted when the API call failed with a transient error (overloaded,
   * rate-limited, network blip) and the session is about to retry. The UI
   * should show a banner like "Retrying (1/3, ~2s)…" and clear it on the
   * next text_delta or terminal event.
   */
  retry?: {
    attempt: number;       // 1-indexed
    maxAttempts: number;   // total attempts allowed
    delayMs: number;       // delay before this retry
    reason: string;        // human-readable, e.g. "overloaded_error", "rate_limit (429)", "ECONNRESET"
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

/** Ephemeral context injected as user messages before each API call */
export interface InjectedContext {
  role: "user";
  content: string;
  cache_control?: { type: "ephemeral" };
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
  /** Set a callback to provide ephemeral context injected as messages (not system prompt) */
  setContextInjector?(injector: () => InjectedContext[]): void;
  /** Force context compaction (Engine B) regardless of token threshold */
  forceCompact?(): AsyncGenerator<AIStreamEvent, void>;
}

export interface CreateWithPromptOptions {
  label: string;
  /** Replaces the base system prompt (e.g. custom system prompt instead of jarvis-system.md) */
  basePromptOverride?: string;
  /** Extra context appended inside <system-reminder> after instructions (e.g. role prompt) */
  roleContext?: string;
}

export interface AISessionFactory {
  create(options?: { label?: string; restoreMessages?: unknown[] }): AISession;
  createWithPrompt(options: CreateWithPromptOptions): AISession;
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /**
   * Optional: attach the EventBus so sessions created by the factory can publish
   * provider-specific telemetry (e.g. per-session usage). Providers that do not
   * emit usage events on the bus may leave this unimplemented.
   */
  setBus?(bus: import("../core/bus.js").EventBus): void;
}

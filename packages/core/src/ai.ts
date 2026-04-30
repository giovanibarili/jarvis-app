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

  /**
   * Set a sticky model override for ALL subsequent calls on this session.
   * Pass `undefined` to clear and revert to the global config model.
   * Optional — providers that don't support per-session model routing leave this unimplemented.
   *
   * @since 2.1.0
   */
  setStickyModelOverride?(model: string | undefined): void;

  /**
   * Set a tool filter for this session. Only tools matching the filter are sent
   * to the model. Pass `undefined` to clear (all tools visible).
   *
   * Use cases:
   *  - Restrict an actor role to a subset of tools (e.g. file-system worker only sees read/edit/grep)
   *  - Block dangerous tools for sandboxed sessions
   *
   * The filter is applied on every API call (the raw `getTools()` registry call
   * is wrapped). Tools registered AFTER setToolFilter is called are also subject
   * to the filter — it's a predicate, not a snapshot.
   *
   * Optional — providers that can't filter at the session boundary leave this unimplemented.
   *
   * @since 2.1.0
   */
  setToolFilter?(filter: ((toolName: string) => boolean) | undefined): void;
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

// --- Session Manager ---

export type SessionState = "idle" | "processing" | "waiting_tools";

export interface ManagedSession {
  session: AISession;
  state: SessionState;
  createdAt: number;
  pendingToolCalls?: CapabilityCall[];
}

/**
 * Central manager for ALL AI sessions (main, grpc-*, actor-*).
 * Provides state tracking, persistence, auto-save, and restore.
 */
export interface SessionManager {
  /** Get or create a session. For actor-* sessions, uses getWithPrompt internally if already registered. */
  get(sessionId: string): ManagedSession;

  /** Get or create a session with custom prompt (for actors). Registers the session if new. */
  getWithPrompt(sessionId: string, options: CreateWithPromptOptions): ManagedSession;

  /** Update session state. Triggers auto-save when transitioning to idle (unless ephemeral). */
  setState(sessionId: string, state: SessionState): void;

  /** Mark a session as ephemeral (never saved to disk) or persistent. */
  setEphemeral(sessionId: string, ephemeral: boolean): void;

  /** Check if a session is ephemeral. */
  isEphemeral(sessionId: string): boolean;

  /** Get current session state. Returns 'idle' if session doesn't exist. */
  getState(sessionId: string): SessionState;

  /** Abort a session — cancels in-flight operations, resets state to idle. */
  abort(sessionId: string): void;

  /** Save a single session's conversation to disk. */
  save(sessionId: string): void;

  /** Save all active sessions to disk. */
  saveAll(): void;

  /** Close and remove a session. Saves before closing. */
  close(sessionId: string): void;

  /** Close all sessions. Saves before closing. */
  closeAll(): void;

  /** Clear saved conversation for a session from disk. */
  clearSaved(sessionId: string): void;

  /** Archive a session (move to archive dir) then clear from disk. */
  archiveSaved(sessionId: string): void;

  /** List saved session labels from disk. Optionally filter by prefix (e.g. "actor-"). */
  listSaved(prefix?: string): string[];

  /** Check if a session exists (without creating it). */
  has(sessionId: string): boolean;

  /** Number of active sessions. */
  readonly size: number;
}

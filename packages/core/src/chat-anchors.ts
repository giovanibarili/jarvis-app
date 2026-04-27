// packages/core/src/chat-anchors.ts
//
// Chat Anchors API — public surface for plugins.
//
// An anchor is a UI element planted in the slot above the chat input. It
// stays visible across multiple AI turns and never scrolls away with the
// timeline. Use cases: choice prompts, sticky banners, plugin
// affordances that must remain reachable.
//
// Plugins receive a `chatAnchors` reference on their PluginContext and
// call `set` to plant. They receive back a `ChatAnchorHandle` to update
// or clear it later.

/** Built-in renderer known to ChatPanel. */
export interface ChatAnchorRendererBuiltin {
  /**
   * Currently supported builtins:
   *   - "choice-card": renders a ChoiceCard from `data.questions`.
   * Plugins MUST NOT use this — register your own React component via
   * the `plugin` variant instead.
   */
  builtin: "choice-card";
  plugin?: undefined;
  file?: undefined;
}

/** Plugin-provided React renderer bundled with the plugin. */
export interface ChatAnchorRendererPlugin {
  /**
   * Plugin component bundled at
   * `/plugins/<plugin>/renderers/<file>.js`. Receives
   *   `{ anchor, onAction }`
   * as props, where `anchor` includes `id`, `data`, and `version`, and
   * `onAction(payload)` POSTs the payload to the registry which forwards
   * it to your backend `onAction` handler.
   */
  builtin?: undefined;
  plugin: string;
  file: string;
}

export type ChatAnchorRenderer = ChatAnchorRendererBuiltin | ChatAnchorRendererPlugin;

/** Spec passed to ChatAnchorRegistry.set(). */
export interface ChatAnchorSpec {
  /** Session this anchor belongs to. */
  sessionId: string;
  /** Owner identifier for debug/UX (e.g. piece id or plugin name). */
  source: string;
  /** Renderer descriptor. */
  renderer: ChatAnchorRenderer;
  /** Arbitrary serializable data exposed to the renderer as `anchor.data`. */
  data: Record<string, unknown>;
  /**
   * Backend handler invoked when the frontend POSTs an action via this
   * anchor. The handler is responsible for clearing the anchor (or
   * updating it) — the registry never auto-clears.
   */
  onAction?: (payload: unknown) => void | Promise<void>;
  /**
   * Explicit id. If omitted, a stable id is generated. Re-using an id
   * that's already alive in the same session throws — call
   * `handle.update()` instead.
   */
  id?: string;
}

/** Handle returned by ChatAnchorRegistry.set(). */
export interface ChatAnchorHandle {
  readonly id: string;
  /** Replace `data` (shallow merge) and bump version. */
  update(patch: Record<string, unknown>): void;
  /** Replace renderer descriptor entirely. */
  setRenderer(renderer: ChatAnchorRenderer): void;
  /** Remove from session. Idempotent. */
  clear(): void;
  /** True until clear() is called or the session is wiped. */
  isAlive(): boolean;
}

/** Public registry interface — surfaced on PluginContext.chatAnchors. */
export interface ChatAnchorRegistry {
  /** Plant an anchor. Returns a handle. */
  set(spec: ChatAnchorSpec): ChatAnchorHandle;
  /** Snapshot of anchors in a session (insertion order). Mostly internal. */
  list(sessionId: string): ReadonlyArray<{
    id: string;
    sessionId: string;
    source: string;
    renderer: ChatAnchorRenderer;
    data: Record<string, unknown>;
    order: number;
    version: number;
  }>;
  /** Remove all anchors in a session (called on session reset). */
  clearSession(sessionId: string): void;
}

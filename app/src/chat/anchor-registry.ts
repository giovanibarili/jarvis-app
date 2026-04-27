// app/src/chat/anchor-registry.ts
//
// Chat Anchor Registry — pure-hook (no bus) registry for UI elements that
// need to live above the chat input, never scrolling away with the timeline.
//
// Design notes:
//
//  • The chat panel has three vertical zones: timeline (scrolls), anchor
//    slot (fixed, above input), and input. Anchors are owned by Pieces
//    (core or plugin) and stay alive across multiple AI turns. Use cases:
//    choice prompts, retry/error banners that must remain visible, sticky
//    progress, plugin-specific affordances.
//
//  • Pure HTTP transport, no bus. Frontend long-polls
//    `GET /chat/anchors?sessionId=…&since=<version>`. Each `set` / `update` /
//    `clear` bumps the per-session version and resolves any pending poll
//    immediately so updates are real-time without bus traffic.
//
//  • Backend handler `onAction` is invoked when the frontend POSTs to
//    `/chat/anchor-action` with `{ id, payload }`. The owning Piece can
//    react (e.g. clear the anchor and inject an AI prompt) without coupling
//    to ChatPanel internals.
//
//  • Lifecycle: anchors persist until `handle.clear()` is called by the
//    owner, or `clearSession(sessionId)` wipes the session (e.g. on
//    `clear_session` capability). Pieces are responsible for their own
//    cleanup; the registry does not auto-expire.
//
//  • Concurrency: long-poll waiters are tracked per-session in a Set. Any
//    mutation drains the Set, allowing pending HTTP responses to flush
//    immediately. New mutations between the resolve and the actual HTTP
//    write are coalesced via the version counter.

export interface AnchorRendererBuiltin {
  /**
   * Built-in renderer known to ChatPanel. Currently supported:
   *   - "choice-card": renders a ChoiceCard from `data.questions`.
   * Plugins may NOT register new builtins — use `plugin` instead.
   */
  builtin: "choice-card";
  plugin?: undefined;
  file?: undefined;
}

export interface AnchorRendererPlugin {
  /**
   * Plugin-provided React component bundled at
   * `/plugins/<plugin>/renderers/<file>.js`. Receives `{ anchor, onAction }`
   * as props (anchor includes `data` and `id`).
   */
  builtin?: undefined;
  plugin: string;
  file: string;
}

export type AnchorRenderer = AnchorRendererBuiltin | AnchorRendererPlugin;

export interface AnchorSpec {
  /** Session this anchor belongs to (e.g. "main", "actor-jarvis-imp"). */
  sessionId: string;
  /** Owner identifier — piece id or plugin name. Shown in debug only. */
  source: string;
  /** Renderer descriptor. */
  renderer: AnchorRenderer;
  /** Arbitrary serializable data passed to the renderer as `anchor.data`. */
  data: Record<string, unknown>;
  /**
   * Backend handler invoked when the frontend POSTs an action to this
   * anchor. The handler is responsible for clearing the anchor (or
   * updating it) — the registry never auto-clears on action so the owner
   * can decide.
   */
  onAction?: (payload: unknown) => void | Promise<void>;
  /**
   * Optional explicit id. If omitted, a stable id is generated. Re-using
   * the same id while another anchor with that id is alive will throw —
   * use `handle.update(...)` instead.
   */
  id?: string;
}

export interface AnchorEntry {
  id: string;
  sessionId: string;
  source: string;
  renderer: AnchorRenderer;
  data: Record<string, unknown>;
  /** Monotonic creation order within the session, for stable rendering. */
  order: number;
  /** Bumped on every update to allow frontend deduplication. */
  version: number;
}

export interface ChatAnchorHandle {
  readonly id: string;
  /** Replace `data` (shallow) and bump version. No-op if cleared. */
  update(patch: Record<string, unknown>): void;
  /** Replace renderer (rare — e.g. swap from loading state to result). */
  setRenderer(renderer: AnchorRenderer): void;
  /** Remove this anchor from its session. */
  clear(): void;
  /** True if the anchor still exists (i.e. clear() not yet called). */
  isAlive(): boolean;
}

interface SessionState {
  /** Insertion-ordered map of anchors. */
  anchors: Map<string, AnchorEntry>;
  /** Per-session version counter; bumps on every mutation. */
  version: number;
  /** Long-poll waiters. Each is a function that resolves the pending HTTP
   *  response with the current snapshot. */
  waiters: Set<() => void>;
  /** Per-session insertion counter for stable ordering. */
  nextOrder: number;
  /** Per-session anonymous-id counter. */
  nextAutoId: number;
}

export class ChatAnchorRegistry {
  private sessions = new Map<string, SessionState>();
  /** Global handler map for action dispatch. */
  private actions = new Map<string, AnchorSpec["onAction"]>();

  /**
   * Register a new anchor. Returns a handle for updating or clearing it
   * later. Throws if `spec.id` is already in use within the same session.
   */
  set(spec: AnchorSpec): ChatAnchorHandle {
    const session = this.ensureSession(spec.sessionId);
    const id = spec.id ?? `a-${session.nextAutoId++}`;
    if (session.anchors.has(id)) {
      throw new Error(
        `ChatAnchorRegistry: anchor id "${id}" already exists in session "${spec.sessionId}". Use handle.update() instead.`,
      );
    }
    const entry: AnchorEntry = {
      id,
      sessionId: spec.sessionId,
      source: spec.source,
      renderer: spec.renderer,
      data: spec.data,
      order: session.nextOrder++,
      version: 1,
    };
    session.anchors.set(id, entry);
    session.version++;
    if (spec.onAction) this.actions.set(this.actionKey(spec.sessionId, id), spec.onAction);
    this.notify(session);

    let alive = true;
    const handle: ChatAnchorHandle = {
      id,
      update: (patch) => {
        if (!alive) return;
        const cur = session.anchors.get(id);
        if (!cur) {
          alive = false;
          return;
        }
        cur.data = { ...cur.data, ...patch };
        cur.version++;
        session.version++;
        this.notify(session);
      },
      setRenderer: (renderer) => {
        if (!alive) return;
        const cur = session.anchors.get(id);
        if (!cur) {
          alive = false;
          return;
        }
        cur.renderer = renderer;
        cur.version++;
        session.version++;
        this.notify(session);
      },
      clear: () => {
        if (!alive) return;
        alive = false;
        session.anchors.delete(id);
        this.actions.delete(this.actionKey(spec.sessionId, id));
        session.version++;
        this.notify(session);
      },
      isAlive: () => alive && session.anchors.has(id),
    };
    return handle;
  }

  /**
   * Snapshot of all anchors in a session, ordered by insertion. Returns a
   * shallow copy — safe to mutate.
   */
  list(sessionId: string): AnchorEntry[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.anchors.values()).sort((a, b) => a.order - b.order);
  }

  /** Current version counter for a session (0 if untouched). */
  version(sessionId: string): number {
    return this.sessions.get(sessionId)?.version ?? 0;
  }

  /**
   * Wait until the session's version exceeds `since`, or until the timeout
   * elapses. Resolves with the current version (which may equal `since` if
   * timed out). Used by long-poll endpoints.
   */
  waitForChange(sessionId: string, since: number, timeoutMs: number): Promise<number> {
    const session = this.ensureSession(sessionId);
    if (session.version > since) {
      return Promise.resolve(session.version);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.waiters.delete(notify);
        resolve(session.version);
      };
      const notify = () => finish();
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      session.waiters.add(notify);
    });
  }

  /**
   * Drop all anchors for a session. Called on `clear_session` capability,
   * SessionManager teardown, or any explicit reset.
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.anchors.size === 0 && session.waiters.size === 0) return;
    // Drop action handlers first
    for (const id of session.anchors.keys()) {
      this.actions.delete(this.actionKey(sessionId, id));
    }
    session.anchors.clear();
    session.version++;
    this.notify(session);
  }

  /**
   * Invoke the action handler for an anchor. Called by the HTTP route
   * `POST /chat/anchor-action`. Returns false if no handler is registered
   * (404 to caller) or true on successful dispatch.
   */
  async invokeAction(sessionId: string, anchorId: string, payload: unknown): Promise<boolean> {
    const handler = this.actions.get(this.actionKey(sessionId, anchorId));
    if (!handler) return false;
    try {
      await handler(payload);
    } catch (err) {
      // Surface to caller via thrown error; logger sits at HTTP layer
      throw err;
    }
    return true;
  }

  private ensureSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        anchors: new Map(),
        version: 0,
        waiters: new Set(),
        nextOrder: 0,
        nextAutoId: 1,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private notify(session: SessionState): void {
    if (session.waiters.size === 0) return;
    // Snapshot waiters before invoking — handlers remove themselves.
    const pending = Array.from(session.waiters);
    session.waiters.clear();
    for (const w of pending) {
      try { w(); } catch { /* swallow — long-poll callers handle their own errors */ }
    }
  }

  private actionKey(sessionId: string, anchorId: string): string {
    return `${sessionId}\u0000${anchorId}`;
  }
}

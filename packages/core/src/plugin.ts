import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { CapabilityRegistry } from "./tools.js";
import type { AISessionFactory, ContextInjectorFn, SessionManager } from "./ai.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  entry?: string;
  capabilities?: {
    tools?: boolean;
    pieces?: boolean;
    renderers?: boolean;
    prompts?: boolean;
  };
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** Child node for the HUD graph overlay. Plugins use this to show sub-items under their piece node. */
export interface GraphNodeChild {
  id: string;
  label: string;
  status: string;
  meta?: Record<string, unknown>;
  children?: () => GraphNodeChild[];
}

/** Scoped handle for a plugin piece to enrich its graph node with children and metadata. */
export interface GraphHandle {
  /** Set or clear a dynamic children callback. Called every render frame — keep it cheap. */
  setChildren(children: (() => GraphNodeChild[]) | undefined): void;
  /** Update status and/or metadata on the piece's graph node. */
  update(patch: { status?: string; meta?: Record<string, unknown>; label?: string }): void;
}

export interface PluginContext {
  bus: EventBus;
  capabilityRegistry: CapabilityRegistry;
  config: Record<string, unknown>;
  pluginDir: string;
  sessionFactory: AISessionFactory;
  /** Central session manager — handles persistence, auto-save, restore for all sessions (added in 0.3.0) */
  sessionManager?: SessionManager;
  registerRoute: (method: string, path: string, handler: RouteHandler) => void;
  saveConfig: (config: Record<string, unknown>) => void;
  registerSlashCommand: (cmd: import("./tools.js").SlashCommand) => void;
  unregisterSlashCommand: (name: string) => void;
  /** Scoped graph handle for registering children on the piece's graph node (added in 0.3.0) */
  graphHandle?: (pieceId: string) => GraphHandle;
  /**
   * Register a context injector that contributes ephemeral messages to
   * every owned AISession (current and future). The callback receives the
   * session id (label) so plugins can scope per-session, filter by privacy,
   * or short-circuit by returning [].
   *
   * Multiple plugins may register injectors independently — the core
   * composes them and concatenates their contributions in registration order.
   *
   * Returns an unregister function. Call it on plugin shutdown to remove
   * the injector cleanly.
   *
   * Use this instead of mutating session.setContextInjector directly: this
   * API supports multi-plugin composition without conflict.
   *
   * @since 0.4.0
   */
  registerContextInjector?: (fn: ContextInjectorFn) => () => void;
}

export interface JarvisPlugin {
  createPieces?(ctx: PluginContext): Piece[];
}

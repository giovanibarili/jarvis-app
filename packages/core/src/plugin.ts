import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { CapabilityRegistry } from "./tools.js";
import type { AISessionFactory, SessionManager } from "./ai.js";
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
}

export interface JarvisPlugin {
  createPieces?(ctx: PluginContext): Piece[];
}

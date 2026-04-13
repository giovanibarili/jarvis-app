// src/capabilities/registry.ts
import type { CapabilityCall, CapabilityResult } from "../ai/types.js";
import { log } from "../logger/index.js";

export type CapabilityHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface CapabilityDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: CapabilityHandler;
}

export type CapabilityExecutionListener = (toolName: string, isError: boolean, timeMs: number) => void;

export class CapabilityRegistry {
  private tools = new Map<string, CapabilityDefinition>();
  private listeners: CapabilityExecutionListener[] = [];

  onExecution(listener: CapabilityExecutionListener): void {
    this.listeners.push(listener);
  }

  register(def: CapabilityDefinition): void {
    this.tools.set(def.name, def);
    log.info({ name: def.name }, "CapabilityRegistry: registered");
  }

  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return [...this.tools.values()].map(({ name, description, input_schema }) => ({
      name, description, input_schema,
    }));
  }

  async execute(calls: CapabilityCall[]): Promise<CapabilityResult[]> {
    return Promise.all(
      calls.map(async (tc) => {
        const def = this.tools.get(tc.name);
        if (!def) {
          return { tool_use_id: tc.id, content: JSON.stringify({ error: `Unknown capability: ${tc.name}` }), is_error: true };
        }
        const t0 = Date.now();
        try {
          log.info({ tool: tc.name, input: tc.input }, "CapabilityRegistry: executing");
          const result = await def.handler(tc.input);
          // If handler returns an array of content blocks (image/text), pass as-is
          if (Array.isArray(result) && result.length > 0 && result[0]?.type && ["image", "text", "document"].includes(result[0].type)) {
            log.info({ tool: tc.name, contentBlocks: result.length, types: result.map((b: any) => b.type) }, "CapabilityRegistry: result (content blocks)");
            for (const l of this.listeners) l(tc.name, false, Date.now() - t0);
            return { tool_use_id: tc.id, content: result };
          }
          const content = JSON.stringify(result);
          log.info({ tool: tc.name, resultLength: content.length, preview: content.slice(0, 200) }, "CapabilityRegistry: result (text)");
          for (const l of this.listeners) l(tc.name, false, Date.now() - t0);
          return { tool_use_id: tc.id, content };
        } catch (err) {
          log.error({ tool: tc.name, input: tc.input, err }, "CapabilityRegistry: handler error");
          for (const l of this.listeners) l(tc.name, true, Date.now() - t0);
          return { tool_use_id: tc.id, content: JSON.stringify({ error: String(err) }), is_error: true };
        }
      })
    );
  }

  /** Get slash-command metadata for the UI (name, description, category) */
  getSlashCommands(): Array<{ name: string; description: string; category: string }> {
    return [...this.tools.values()].map(({ name, description }) => {
      let category = "general";
      if (name.startsWith("mcp__")) category = "mcp";
      else if (["bash", "read_file", "write_file", "edit_file", "glob", "grep", "list_dir"].includes(name)) category = "filesystem";
      else if (["web_fetch", "web_search"].includes(name)) category = "web";
      else if (["model_set", "model_get"].includes(name)) category = "model";
      else if (["piece_list", "piece_enable", "piece_disable", "hud_show", "hud_hide"].includes(name)) category = "pieces";
      else if (["actor_dispatch", "actor_list", "actor_kill", "bus_publish"].includes(name)) category = "actors";
      else if (["cron_create", "cron_list", "cron_delete"].includes(name)) category = "cron";
      else if (["plugin_install", "plugin_list", "plugin_update", "plugin_enable", "plugin_disable", "plugin_remove"].includes(name)) category = "plugins";
      else if (["grpc_start", "grpc_stop", "grpc_status"].includes(name)) category = "grpc";
      else if (["mcp_list", "mcp_connect", "mcp_disconnect", "mcp_login", "mcp_refresh"].includes(name)) category = "mcp";
      else if (["conversation_clear", "jarvis_reset"].includes(name)) category = "system";
      return { name, description, category };
    });
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }
}

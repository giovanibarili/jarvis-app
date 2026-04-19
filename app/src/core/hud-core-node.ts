// src/core/hud-core-node.ts
// HUD Core Node piece — pushes the GraphRegistry tree to the HUD every 500ms.
// Also auto-registers actor-pool and other plugin pieces that can't import graphRegistry directly.

import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { HudUpdateMessage, SystemEventMessage } from "./types.js";
import { graphRegistry } from "./graph-registry.js";
import { log } from "../logger/index.js";

const UPDATE_INTERVAL_MS = 500;

export class HudCoreNodePiece implements Piece {
  readonly id = "hud-core-node";
  readonly name = "Core Node";

  private bus!: EventBus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];

  // Track actor-pool actors via system events (since plugins can't import graphRegistry)
  private actors = new Map<string, { name: string; role: string; status: string }>();

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Auto-register actor-pool as a graph node with live children
    graphRegistry.register({
      id: "actor-pool",
      label: "Actors",
      status: "running",
      meta: { max: 5 },
      children: () => [...this.actors.values()].map(a => ({
        id: `actor-${a.name}`,
        label: a.name,
        status: a.status,
        meta: { role: a.role },
      })),
    });

    // Listen for actor lifecycle events
    this.unsubs.push(
      bus.subscribe<SystemEventMessage>("system.event", (msg) => {
        // Actor created via dispatch or HUD create
        if (msg.event === "actor.dispatch.result" || msg.event === "actor.session.create") {
          const name = msg.data?.name as string;
          const roleRaw = msg.data?.role;
          const role = typeof roleRaw === "string" ? roleRaw
            : (roleRaw as any)?.id as string ?? msg.data?.roleId as string ?? "generic";
          if (name && !this.actors.has(name)) {
            this.actors.set(name, { name, role, status: "idle" });
            graphRegistry.update("actor-pool", { meta: { max: 5, active: this.actors.size } });
          }
        }
        // Actor killed via HUD or API
        if (msg.event === "actor.kill" || msg.event === "actor.kill.request") {
          const name = msg.data?.name as string;
          if (name) {
            this.actors.delete(name);
            graphRegistry.update("actor-pool", { meta: { max: 5, active: this.actors.size } });
          }
        }
      })
    );

    // Listen for actor state changes via ai.stream
    this.unsubs.push(
      bus.subscribe<any>("ai.stream", (msg) => {
        if (!msg.target?.startsWith("actor-")) return;
        const name = msg.target.replace("actor-", "");
        const actor = this.actors.get(name);
        if (!actor) return;

        switch (msg.event) {
          case "delta":
            if (actor.status !== "processing") actor.status = "processing";
            break;
          case "tool_start":
            actor.status = "waiting_tools";
            break;
          case "tool_done":
            // Back to processing after tool completes (AI will continue)
            actor.status = "processing";
            break;
          case "complete":
          case "error":
          case "aborted":
            actor.status = "idle";
            break;
        }
      })
    );

    // Register HUD panel
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "overlay",
        name: this.name,
        status: "running",
        data: { tree: graphRegistry.getTree() },
        position: { x: 0, y: 0 },
        size: { width: 0, height: 0 },
        visible: false,  // not rendered as a panel — consumed by HudRenderer directly
      },
    });

    // Push tree updates periodically
    this.timer = setInterval(() => {
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: { tree: graphRegistry.getTree() },
      });
    }, UPDATE_INTERVAL_MS);

    log.info("HudCoreNodePiece: started");
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    graphRegistry.unregister("actor-pool");
    this.bus?.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("HudCoreNodePiece: stopped");
  }
}

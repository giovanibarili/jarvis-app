// src/core/hud-core-node.ts
// HUD Core Node piece — reads graphRegistry.getTree() and pushes it to the HUD every 500ms.
//
// This piece is a pure reader — it never registers/unregisters graph nodes.
// PieceManager owns core node registration; pieces enrich their nodes with children/meta.

import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import { graphRegistry } from "./graph-registry.js";
import { log } from "../logger/index.js";

const UPDATE_INTERVAL_MS = 500;

export class HudCoreNodePiece implements Piece {
  readonly id = "hud-core-node";
  readonly name = "Core Node";

  private bus!: EventBus;
  private timer: ReturnType<typeof setInterval> | null = null;

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

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
    this.bus?.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("HudCoreNodePiece: stopped");
  }
}

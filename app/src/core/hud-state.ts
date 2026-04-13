// src/core/hud-state.ts
import type { EventBus } from "./bus.js";
import type { HudPieceData } from "./piece.js";
import type { HudUpdateMessage } from "./types.js";
import { load as loadSettings } from "./settings.js";
import { log } from "../logger/index.js";

export class HudState {
  private pieces = new Map<string, HudPieceData>();

  constructor(bus: EventBus) {
    bus.subscribe<HudUpdateMessage>("hud.update", (msg) => {
      switch (msg.action) {
        case "add": {
          const piece = msg.piece!;
          // Override with saved layout from settings
          const saved = loadSettings().pieces?.[piece.pieceId]?.config?.layout as any;
          if (saved) {
            piece.position = { x: saved.x, y: saved.y };
            piece.size = { width: saved.width, height: saved.height };
          }
          this.pieces.set(piece.pieceId, piece);
          log.debug({ pieceId: piece.pieceId, type: piece.type, savedLayout: !!saved }, "HudState: added");
          break;
        }
        case "update": {
          const existing = this.pieces.get(msg.pieceId);
          if (existing) {
            existing.data = { ...existing.data, ...msg.data };
            if (msg.status) existing.status = msg.status;
            if (msg.visible !== undefined) existing.visible = msg.visible;
            log.debug({ pieceId: msg.pieceId }, "HudState: updated");
          }
          break;
        }
        case "remove": {
          this.pieces.delete(msg.pieceId);
          log.debug({ pieceId: msg.pieceId }, "HudState: removed");
          break;
        }
      }
    });
  }

  getState(): Record<string, unknown> {
    const components = [...this.pieces.values()].map(p => ({
      id: p.pieceId,
      name: p.name,
      status: p.status,
      visible: p.visible !== false,
      hudConfig: { type: p.type, draggable: true, resizable: true },
      position: p.position ?? { x: 0, y: 0 },
      size: p.size ?? { width: 200, height: 100 },
      data: p.data,
      renderer: p.renderer,
    }));

    // Find jarvis-core for reactor state
    const core = this.pieces.get("jarvis-core");
    const reactor = core
      ? { status: core.data.status as string ?? "online", coreLabel: core.data.coreLabel as string ?? "ONLINE", coreSubLabel: "" }
      : { status: "offline", coreLabel: "OFFLINE", coreSubLabel: "" };

    return { reactor, components };
  }
}

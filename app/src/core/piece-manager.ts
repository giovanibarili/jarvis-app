// src/core/piece-manager.ts
import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { HudUpdateMessage } from "./types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { load, save, getPieceSettings, setPieceSettings, isProtected, type Settings } from "./settings.js";
import { log } from "../logger/index.js";

export class PieceManager {
  readonly pieces: Map<string, Piece>;
  private running = new Set<string>();
  private bus: EventBus;
  private registry: CapabilityRegistry;
  private settings: Settings;

  constructor(pieces: Piece[], bus: EventBus, registry: CapabilityRegistry) {
    this.pieces = new Map(pieces.map(p => [p.id, p]));
    this.bus = bus;
    this.registry = registry;
    this.settings = load();
    this.registerTools();
  }

  async startAll(): Promise<void> {
    for (const piece of this.pieces.values()) {
      const ps = getPieceSettings(this.settings, piece.id);
      if (!ps.enabled) {
        log.info({ pieceId: piece.id }, "PieceManager: skipped (disabled in settings)");
        continue;
      }
      await piece.start(this.bus);
      this.running.add(piece.id);

      // Apply visibility from settings
      if (!ps.visible) {
        this.setVisible(piece.id, false);
      }
    }
    log.info({ running: [...this.running], total: this.pieces.size }, "PieceManager: started");
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.running].reverse();
    for (const id of reversed) {
      const piece = this.pieces.get(id);
      if (piece) await piece.stop();
    }
    this.running.clear();
    log.info("PieceManager: all stopped");
  }

  async enable(pieceId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.pieces.has(pieceId)) return { ok: false, error: `Unknown piece: ${pieceId}` };
    if (this.running.has(pieceId)) return { ok: false, error: `${pieceId} is already running` };

    const piece = this.pieces.get(pieceId)!;
    await piece.start(this.bus);
    this.running.add(pieceId);

    this.settings = setPieceSettings(this.settings, pieceId, { enabled: true });
    save(this.settings);

    log.info({ pieceId }, "PieceManager: enabled");
    return { ok: true };
  }

  async disable(pieceId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.pieces.has(pieceId)) return { ok: false, error: `Unknown piece: ${pieceId}` };
    if (isProtected(pieceId)) return { ok: false, error: `${pieceId} is protected and cannot be disabled` };
    if (!this.running.has(pieceId)) return { ok: false, error: `${pieceId} is not running` };

    const piece = this.pieces.get(pieceId)!;
    await piece.stop();
    this.running.delete(pieceId);

    this.settings = setPieceSettings(this.settings, pieceId, { enabled: false });
    save(this.settings);

    log.info({ pieceId }, "PieceManager: disabled");
    return { ok: true };
  }

  async registerDynamic(piece: Piece, source: string): Promise<{ ok: boolean; error?: string }> {
    if (this.pieces.has(piece.id)) {
      return { ok: false, error: `Piece ${piece.id} already registered` };
    }

    this.pieces.set(piece.id, piece);

    // If PieceManager already started, start this piece immediately
    if (this.running.size > 0) {
      await piece.start(this.bus);
      this.running.add(piece.id);
    }

    // Create default settings entry — reload from disk to avoid overwriting other changes
    this.settings = load();
    const existing = getPieceSettings(this.settings, piece.id);
    // Only set defaults if piece has no settings yet — preserve visible state
    if (!this.settings.pieces[piece.id]) {
      this.settings = setPieceSettings(this.settings, piece.id, { enabled: true, visible: true });
      save(this.settings);
    }

    // Apply saved visibility
    if (!existing.visible) {
      this.setVisible(piece.id, false);
    }

    log.info({ pieceId: piece.id, source }, "PieceManager: registered dynamic piece");
    return { ok: true };
  }

  async unregisterDynamic(pieceId: string): Promise<{ ok: boolean; error?: string }> {
    const piece = this.pieces.get(pieceId);
    if (!piece) return { ok: false, error: `Piece ${pieceId} not found` };

    if (this.running.has(pieceId)) {
      await piece.stop();
      this.running.delete(pieceId);
    }

    this.pieces.delete(pieceId);
    // Don't delete settings — preserves layout for re-enable

    log.info({ pieceId }, "PieceManager: unregistered dynamic piece");
    return { ok: true };
  }

  show(pieceId: string): { ok: boolean; error?: string } {
    this.setVisible(pieceId, true);
    this.settings = setPieceSettings(this.settings, pieceId, { visible: true });
    save(this.settings);
    return { ok: true };
  }

  hide(pieceId: string): { ok: boolean; error?: string } {
    this.setVisible(pieceId, false);
    this.settings = setPieceSettings(this.settings, pieceId, { visible: false });
    save(this.settings);
    return { ok: true };
  }

  setLayout(pieceId: string, x: number, y: number, width: number, height: number): { ok: boolean; error?: string } {
    // Update settings
    this.settings = load();
    if (!this.settings.pieces[pieceId]) {
      this.settings.pieces[pieceId] = { enabled: true, visible: true };
    }
    this.settings.pieces[pieceId].config = {
      ...this.settings.pieces[pieceId].config,
      layout: { x, y, width, height },
    };
    save(this.settings);

    // Push to HUD live
    this.bus.publish({
      channel: "hud.update",
      source: "piece-manager",
      action: "update",
      pieceId,
      data: {},
      layout: { x, y, width, height },
    });

    log.info({ pieceId, x, y, width, height }, "PieceManager: layout updated");
    return { ok: true };
  }

  private setVisible(pieceId: string, visible: boolean): void {
    this.bus.publish({
      channel: "hud.update",
      source: "piece-manager",
      action: "update",
      pieceId,
      data: {},
      visible,
    });
    log.debug({ pieceId, visible }, "PieceManager: visibility changed");
  }

  private registerTools(): void {
    this.registry.register({
      name: "piece_list",
      description: "List all JARVIS pieces with their enabled/running/visible status.",
      input_schema: { type: "object", properties: {} },
      handler: async () => {
        return [...this.pieces.values()].map(p => ({
          id: p.id,
          name: p.name,
          enabled: getPieceSettings(this.settings, p.id).enabled,
          running: this.running.has(p.id),
          visible: getPieceSettings(this.settings, p.id).visible,
          protected: isProtected(p.id),
        }));
      },
    });

    this.registry.register({
      name: "piece_enable",
      description: "Enable and start a JARVIS piece. Use piece_list to see available pieces.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece ID to enable" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.enable(String(input.piece_id)),
    });

    this.registry.register({
      name: "piece_disable",
      description: "Disable and stop a JARVIS piece. Protected pieces cannot be disabled.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece ID to disable" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.disable(String(input.piece_id)),
    });

    this.registry.register({
      name: "hud_show",
      description: "Show a HUD panel that was previously hidden.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece/panel ID to show" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.show(String(input.piece_id)),
    });

    this.registry.register({
      name: "hud_hide",
      description: "Hide a HUD panel without disabling the piece.",
      input_schema: {
        type: "object",
        properties: { piece_id: { type: "string", description: "The piece/panel ID to hide" } },
        required: ["piece_id"],
      },
      handler: async (input) => this.hide(String(input.piece_id)),
    });

    this.registry.register({
      name: "hud_layout",
      description: "Set position and size of a HUD panel. Persists to settings so it survives restarts.",
      input_schema: {
        type: "object",
        properties: {
          piece_id: { type: "string", description: "The piece/panel ID to reposition" },
          x: { type: "number", description: "X position in pixels" },
          y: { type: "number", description: "Y position in pixels" },
          width: { type: "number", description: "Width in pixels" },
          height: { type: "number", description: "Height in pixels" },
        },
        required: ["piece_id", "x", "y", "width", "height"],
      },
      handler: async (input) => this.setLayout(
        String(input.piece_id),
        Number(input.x), Number(input.y),
        Number(input.width), Number(input.height),
      ),
    });
  }
}

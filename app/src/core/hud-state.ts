// src/core/hud-state.ts
// Manages HUD panel state. Provides:
// 1. getState() — full snapshot for initial load (GET /hud)
// 2. SSE stream — pushes deltas only when piece content actually changed (dirty check)
import type { ServerResponse } from "node:http";
import type { EventBus } from "./bus.js";
import type { HudPieceData } from "./piece.js";
import type { HudUpdateMessage } from "./types.js";
import { load as loadSettings } from "./settings.js";
import { log } from "../logger/index.js";

/** Serialized piece for the frontend */
interface HudComponent {
  id: string;
  name: string;
  status: string;
  visible: boolean;
  ephemeral: boolean;
  hudConfig: { type: string; draggable: boolean; resizable: boolean };
  position: { x: number; y: number };
  size: { width: number; height: number };
  data: Record<string, unknown>;
  renderer?: { plugin: string; file: string };
}

/** SSE delta event sent to frontend */
interface HudDelta {
  action: "set" | "remove";
  pieceId: string;
  component?: HudComponent;
  reactor?: { status: string; coreLabel: string; coreSubLabel: string };
}

export class HudState {
  private pieces = new Map<string, HudPieceData>();
  private streamClients = new Set<ServerResponse>();

  // Dirty-check: store JSON hash of last pushed component per piece
  private lastPushed = new Map<string, string>();
  private lastReactorHash = "";

  constructor(bus: EventBus) {
    bus.subscribe<HudUpdateMessage>("hud.update", (msg) => {
      switch (msg.action) {
        case "add": {
          const piece = msg.piece!;
          // Override with saved layout from settings (skip ephemeral panels)
          if (!piece.ephemeral) {
            const saved = loadSettings().pieces?.[piece.pieceId]?.config?.layout as any;
            if (saved) {
              piece.position = { x: saved.x, y: saved.y };
              piece.size = { width: saved.width, height: saved.height };
            }
          }
          this.pieces.set(piece.pieceId, piece);
          log.debug({ pieceId: piece.pieceId, type: piece.type, ephemeral: !!piece.ephemeral }, "HudState: added");
          this.pushIfChanged(piece.pieceId);
          break;
        }
        case "update": {
          const existing = this.pieces.get(msg.pieceId);
          if (existing) {
            existing.data = { ...existing.data, ...msg.data };
            if (msg.status) existing.status = msg.status;
            if (msg.visible !== undefined) existing.visible = msg.visible;
            if (msg.layout) {
              existing.position = { x: msg.layout.x, y: msg.layout.y };
              existing.size = { width: msg.layout.width, height: msg.layout.height };
            }
            log.trace({ pieceId: msg.pieceId }, "HudState: updated");
            this.pushIfChanged(msg.pieceId);
          }
          break;
        }
        case "remove": {
          this.pieces.delete(msg.pieceId);
          this.lastPushed.delete(msg.pieceId);
          log.debug({ pieceId: msg.pieceId }, "HudState: removed");

          const delta: HudDelta = {
            action: "remove",
            pieceId: msg.pieceId,
            ...(msg.pieceId === "jarvis-core" ? { reactor: this.getReactor() } : {}),
          };
          this.pushDelta(delta);
          break;
        }
      }
    });
  }

  // ─── Full snapshot (used by GET /hud for initial load) ───────────────────

  getState(): Record<string, unknown> {
    const components = [...this.pieces.values()].map(p => this.serializePiece(p));
    return { reactor: this.getReactor(), components };
  }

  // ─── SSE stream (used by GET /hud-stream) ───────────────────────────────

  addStreamClient(res: ServerResponse): void {
    this.streamClients.add(res);
    // trace level — these events fire on every HUD repaint and would
    // flood the log file. Promote to debug only when actively diagnosing
    // SSE client churn.
    log.trace({ clients: this.streamClients.size }, "HudState: SSE client connected");
  }

  removeStreamClient(res: ServerResponse): void {
    this.streamClients.delete(res);
    log.trace({ clients: this.streamClients.size }, "HudState: SSE client disconnected");
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private serializePiece(p: HudPieceData): HudComponent {
    return {
      id: p.pieceId,
      name: p.name,
      status: p.status,
      visible: p.visible !== false,
      ephemeral: p.ephemeral ?? false,
      hudConfig: { type: p.type, draggable: true, resizable: true },
      position: p.position ?? { x: 0, y: 0 },
      size: p.size ?? { width: 200, height: 100 },
      data: p.data,
      renderer: p.renderer,
    };
  }

  private getReactor(): { status: string; coreLabel: string; coreSubLabel: string } {
    const core = this.pieces.get("jarvis-core");
    return core
      ? { status: core.data.status as string ?? "online", coreLabel: core.data.coreLabel as string ?? "ONLINE", coreSubLabel: "" }
      : { status: "offline", coreLabel: "OFFLINE", coreSubLabel: "" };
  }

  /** Only push SSE delta if the serialized component actually changed.
   *  Uses a stable hash that excludes volatile fields (e.g. streamingElapsedMs)
   *  which change every call but are cosmetic — the frontend computes elapsed locally. */
  private pushIfChanged(pieceId: string): void {
    if (this.streamClients.size === 0) return;

    const piece = this.pieces.get(pieceId);
    if (!piece) return;

    const component = this.serializePiece(piece);
    const hash = this.stableHash(component);
    const prev = this.lastPushed.get(pieceId);
    if (prev === hash) return; // No change — skip SSE push

    this.lastPushed.set(pieceId, hash);

    // Check if reactor changed too (only relevant for jarvis-core)
    const delta: HudDelta = { action: "set", pieceId, component };
    if (pieceId === "jarvis-core") {
      const reactor = this.getReactor();
      const reactorHash = JSON.stringify(reactor);
      if (reactorHash !== this.lastReactorHash) {
        this.lastReactorHash = reactorHash;
        delta.reactor = reactor;
      }
    }

    this.pushDelta(delta);
  }

  /** Hash component data excluding volatile/cosmetic fields that change every tick */
  private stableHash(component: HudComponent): string {
    const { data, ...rest } = component;
    // Filter out fields that are purely cosmetic timers (change every call but carry no new info)
    const stableData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === "streamingElapsedMs") continue; // frontend computes this from streamingStartMs
      stableData[k] = v;
    }
    return JSON.stringify({ ...rest, data: stableData });
  }

  private pushDelta(delta: HudDelta): void {
    if (this.streamClients.size === 0) return;
    const msg = `data: ${JSON.stringify(delta)}\n\n`;
    for (const client of this.streamClients) {
      try { client.write(msg); } catch {}
    }
  }
}

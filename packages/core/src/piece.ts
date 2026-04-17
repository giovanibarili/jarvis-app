import type { EventBus } from "./bus.js";

export interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  systemContext?(): string;
}

export type HudPieceType = "panel" | "indicator" | "overlay";

export interface HudPieceData {
  pieceId: string;
  type: HudPieceType;
  name: string;
  status: string;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  visible?: boolean;
  /** If true, layout/visibility changes are NOT persisted to settings.
   *  Use for transient panels (e.g. actor chats) that shouldn't pollute the config. */
  ephemeral?: boolean;
  renderer?: { plugin: string; file: string };
}

// Re-export HUD types from @jarvis/core — no EventBus dependency
export type {
  HudPieceType,
  HudPieceData,
} from "@jarvis/core";

// App keeps its own Piece interface — it references the app's EventBus (with pino logging),
// which is structurally distinct from @jarvis/core's EventBus due to private fields.
import type { EventBus } from "./bus.js";

export interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  /** Optional context this piece contributes to the system prompt.
   *  @param sessionId — identifies which session is requesting context (for per-session state) */
  systemContext?(sessionId?: string): string;
}

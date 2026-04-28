// Channel-based message system for JARVIS EventBus

import type { CapabilityCall, CapabilityResult } from "./tools.js";
import type { HudPieceData } from "./piece.js";

export type Channel = "ai.request" | "ai.stream" | "capability.request" | "capability.result" | "hud.update" | "system.event" | "chat.anchor";

export interface BusMessage {
  id: string;
  timestamp: number;
  source: string;
  target?: string;
  channel: Channel;
}

// Image attachment for multi-modal messages
export interface ImageAttachment {
  /** Sequential label: "Image #1", "Image #2", etc. */
  label: string;
  /** Base64-encoded image data (no data: prefix) */
  base64: string;
  /** MIME type: image/png, image/jpeg, image/gif, image/webp */
  mediaType: string;
}

// ai.request — someone wants an AI session to process a prompt
export interface AIRequestMessage extends BusMessage {
  channel: "ai.request";
  text: string;
  images?: ImageAttachment[];
  replyTo?: string;
  /**
   * Optional payload for dispatch metadata.
   *
   * Conventional keys (consumed by core pieces):
   *   - `utility: true` — this is a utility call (summary, classification,
   *     title generation, etc). The ModelRouter routes it to the configured
   *     utility model (Haiku by default) WITHOUT touching the session's
   *     sticky model. Use for isolated, one-shot calls that don't share
   *     cache with the main loop.
   *   - `actorRole`, `actorContext` — actor-runner plugin metadata.
   *   - any other plugin-specific key.
   */
  data?: Record<string, unknown> & { utility?: boolean };
}

// ai.stream — tokens coming from any AI session
export interface AIStreamMessage extends BusMessage {
  channel: "ai.stream";
  event: "delta" | "complete" | "error" | "tool_start" | "tool_done" | "tool_cancelled" | "aborted" | "compaction";
  text?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  toolName?: string;
  toolId?: string;
  toolMs?: number;
  toolArgs?: string;
  toolOutput?: string;
  compaction?: {
    summary: string;
    engine: 'api' | 'fallback';
    tokensBefore: number;
    tokensAfter: number;
  };
}

// capability.request — AI session wants to execute capabilities
export interface CapabilityRequestMessage extends BusMessage {
  channel: "capability.request";
  calls: CapabilityCall[];
}

// capability.result — capability execution results
export interface CapabilityResultMessage extends BusMessage {
  channel: "capability.result";
  results: CapabilityResult[];
}

// hud.update — panel lifecycle
export interface HudUpdateMessage extends BusMessage {
  channel: "hud.update";
  action: "add" | "update" | "remove";
  pieceId: string;
  piece?: HudPieceData;
  data?: Record<string, unknown>;
  status?: string;
  visible?: boolean;
  layout?: { x: number; y: number; width: number; height: number };
}

// system.event — everything else (health, MCP, api usage, etc.)
export interface SystemEventMessage extends BusMessage {
  channel: "system.event";
  event: string;
  data: Record<string, unknown>;
}

// chat.anchor — pieces declare/remove/clear UI anchors that float above the
// chat composer (per-session). Generic mechanism: any piece can publish.
// The frontend AnchorRegistry consumes via SSE forwarding in ChatPiece.
export interface ChatAnchor {
  /** Unique within (sessionId, source). */
  id: string;
  /** Session scope — anchors NEVER cross sessions. Required. */
  sessionId: string;
  /** Owner identifier (piece id, plugin name, etc.) for diagnostics. */
  source: string;
  /** Higher = rendered higher in the stack. Default 0. */
  priority?: number;
  /** Discriminator interpreted by the front renderer registry.
   *  Built-in: "choice". Plugins can register their own kinds. */
  rendererKind: string;
  /** Arbitrary data the renderer consumes. */
  payload: unknown;
  /** Optional plugin renderer (loaded via /plugins/<plugin>/renderers/<file>.js)
   *  if the kind is not built-in. */
  renderer?: { plugin: string; file: string };
  /** Auto-remove after this many ms (clock starts at set time). */
  ttlMs?: number;
  /** Wallclock ms; set automatically by the registry if missing. */
  createdAt?: number;
}

export interface ChatAnchorMessage extends BusMessage {
  channel: "chat.anchor";
  /** Always carries sessionId for routing — even on remove/clear. */
  sessionId: string;
  action: "set" | "remove" | "clear";
  /** Required when action === "set". */
  anchor?: ChatAnchor;
  /** Required when action === "remove". */
  anchorId?: string;
}

export type AnyBusMessage = AIRequestMessage | AIStreamMessage | CapabilityRequestMessage | CapabilityResultMessage | HudUpdateMessage | SystemEventMessage | ChatAnchorMessage;

// Distributive Omit — preserves union discrimination when omitting keys
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

// Type for bus.publish() — auto-filled fields (id, timestamp) omitted, union preserved
export type PublishMessage = DistributiveOmit<AnyBusMessage, "id" | "timestamp">;

// Handler type
export type MessageHandler<T extends BusMessage = BusMessage> = (msg: T) => void | Promise<void>;

// Channel-based message system for JARVIS EventBus

import type { CapabilityCall, CapabilityResult } from "./tools.js";
import type { HudPieceData } from "./piece.js";

export type Channel = "ai.request" | "ai.stream" | "capability.request" | "capability.result" | "hud.update" | "system.event";

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
}

// ai.stream — tokens coming from any AI session
export interface AIStreamMessage extends BusMessage {
  channel: "ai.stream";
  event: "delta" | "complete" | "error" | "tool_start" | "tool_done" | "tool_cancelled" | "aborted";
  text?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  toolName?: string;
  toolId?: string;
  toolMs?: number;
  toolArgs?: string;
  toolOutput?: string;
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
}

// system.event — everything else (health, MCP, api usage, etc.)
export interface SystemEventMessage extends BusMessage {
  channel: "system.event";
  event: string;
  data: Record<string, unknown>;
}

export type AnyBusMessage = AIRequestMessage | AIStreamMessage | CapabilityRequestMessage | CapabilityResultMessage | HudUpdateMessage | SystemEventMessage;

// Distributive Omit — preserves union discrimination when omitting keys
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

// Type for bus.publish() — auto-filled fields (id, timestamp) omitted, union preserved
export type PublishMessage = DistributiveOmit<AnyBusMessage, "id" | "timestamp">;

// Handler type
export type MessageHandler<T extends BusMessage = BusMessage> = (msg: T) => void | Promise<void>;

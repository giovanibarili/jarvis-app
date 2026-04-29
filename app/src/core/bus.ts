// src/core/bus.ts — pino-logging version of the typed channel EventBus
import { log } from "../logger/index.js";
import { newTraceId } from "../logger/trace.js";
import type { Channel, BusMessage, AnyBusMessage, PublishMessage, MessageHandler } from "@jarvis/core";

type Subscription = {
  channel: Channel;
  handler: MessageHandler;
};

/**
 * Channels promoted to `info` level so the end-to-end conversation flow
 * (user prompt → AI request → stream → tool call → result) is visible
 * without enabling debug. Hot, high-volume channels (`hud.update`) stay
 * at debug to avoid swamping the log.
 */
const INFO_CHANNELS = new Set<Channel>([
  "ai.request",
  "ai.stream",
  "capability.request",
  "capability.result",
  "chat.anchor",
]);

/**
 * For ai.stream we further suppress `delta` events at info — they fire
 * once per token and would flood the log. Other event subtypes (complete,
 * tool_start, tool_done, error, aborted) are kept.
 */
function shouldLogAtInfo(msg: AnyBusMessage): boolean {
  if (!INFO_CHANNELS.has(msg.channel)) return false;
  if (msg.channel === "ai.stream" && (msg as any).event === "delta") return false;
  return true;
}

function summarizeMessage(msg: AnyBusMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    channel: msg.channel,
    source: msg.source,
    target: msg.target,
    traceId: msg.traceId,
    eventId: msg.id,
  };
  switch (msg.channel) {
    case "ai.request": {
      const m: any = msg;
      base.preview = typeof m.text === "string" ? m.text.slice(0, 120) : undefined;
      base.images = Array.isArray(m.images) ? m.images.length : 0;
      base.replyTo = m.replyTo;
      base.utility = m.data?.utility ? true : undefined;
      break;
    }
    case "ai.stream": {
      const m: any = msg;
      base.event = m.event;
      if (m.event === "complete") base.textLength = (m.text ?? "").length;
      if (m.event === "tool_start" || m.event === "tool_done" || m.event === "tool_cancelled") {
        base.toolName = m.toolName;
        base.toolId = m.toolId;
      }
      if (m.event === "error") base.error = m.error;
      break;
    }
    case "capability.request": {
      const m: any = msg;
      base.calls = Array.isArray(m.calls) ? m.calls.map((c: any) => ({ name: c.name, id: c.id })) : undefined;
      break;
    }
    case "capability.result": {
      const m: any = msg;
      base.results = Array.isArray(m.results)
        ? m.results.map((r: any) => ({ id: r.tool_use_id, isError: r.is_error }))
        : undefined;
      break;
    }
    case "chat.anchor": {
      const m: any = msg;
      base.anchor = m.anchor;
      break;
    }
  }
  return base;
}

export class EventBus {
  private subscriptions: Subscription[] = [];
  private eventCount = 0;

  publish(msg: PublishMessage): void {
    const full = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      // Auto-fill traceId if the publisher didn't provide one. Keeps logs
      // correlatable for legacy callers and one-off events that didn't
      // carry a trace. Originating user-input publishers SHOULD provide
      // one to share a single id end-to-end.
      traceId: (msg as AnyBusMessage).traceId ?? newTraceId(),
    } as AnyBusMessage;

    this.eventCount++;
    const summary = summarizeMessage(full);
    if (shouldLogAtInfo(full)) {
      log.info(summary, "bus: publish");
    } else {
      log.debug(summary, "bus: publish");
    }

    let delivered = 0;
    for (const sub of this.subscriptions) {
      if (sub.channel === full.channel) {
        delivered++;
        try {
          const result = sub.handler(full);
          if (result instanceof Promise) {
            result.catch(err => log.error({
              channel: full.channel,
              source: full.source,
              target: full.target,
              traceId: full.traceId,
              err: err instanceof Error ? err.message : String(err),
            }, "bus: async handler error"));
          }
        } catch (err) {
          log.error({
            channel: full.channel,
            traceId: full.traceId,
            err,
          }, "bus: handler error (sync)");
        }
      }
    }

    if (delivered === 0 && shouldLogAtInfo(full)) {
      log.warn({
        channel: full.channel,
        traceId: full.traceId,
        target: full.target,
      }, "bus: published but no subscribers");
    }
  }

  subscribe<T extends BusMessage>(channel: Channel, handler: MessageHandler<T>): () => void {
    const sub: Subscription = { channel, handler: handler as MessageHandler };
    this.subscriptions.push(sub);
    log.debug({ channel, totalForChannel: this.subscriptions.filter(s => s.channel === channel).length }, "bus: subscribe");
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  get stats() {
    return { subscriptions: this.subscriptions.length, events: this.eventCount };
  }
}

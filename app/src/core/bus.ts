// src/core/bus.ts — pino-logging version of the typed channel EventBus
import { log } from "../logger/index.js";
import type { Channel, BusMessage, AnyBusMessage, PublishMessage, MessageHandler } from "@jarvis/core";

type Subscription = {
  channel: Channel;
  handler: MessageHandler;
};

export class EventBus {
  private subscriptions: Subscription[] = [];
  private eventCount = 0;

  publish(msg: PublishMessage): void {
    const full = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    } as AnyBusMessage;

    this.eventCount++;
    log.debug({ channel: full.channel, source: full.source, target: full.target, eventId: full.id }, "bus: publish");

    for (const sub of this.subscriptions) {
      if (sub.channel === full.channel) {
        try {
          const result = sub.handler(full);
          if (result instanceof Promise) {
            result.catch(err => log.error(`bus: handler error on ${full.channel}: ${err instanceof Error ? err.message + '\n' + err.stack : String(err)}`));
          }
        } catch (err) {
          log.error({ channel: full.channel, err }, "bus: handler error (sync)");
        }
      }
    }
  }

  subscribe<T extends BusMessage>(channel: Channel, handler: MessageHandler<T>): () => void {
    const sub: Subscription = { channel, handler: handler as MessageHandler };
    this.subscriptions.push(sub);
    log.debug({ channel }, "bus: subscribe");
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  get stats() {
    return { subscriptions: this.subscriptions.length, events: this.eventCount };
  }
}

import type { Channel, BusMessage, AnyBusMessage, PublishMessage, MessageHandler } from "./types.js";

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

    for (const sub of this.subscriptions) {
      if (sub.channel === full.channel) {
        try {
          const result = sub.handler(full);
          if (result instanceof Promise) {
            result.catch(err => console.error(`bus: handler error on ${full.channel}:`, err));
          }
        } catch (err) {
          console.error(`bus: handler error (sync) on ${full.channel}:`, err);
        }
      }
    }
  }

  subscribe<T extends BusMessage>(channel: Channel, handler: MessageHandler<T>): () => void {
    const sub: Subscription = { channel, handler: handler as MessageHandler };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  get stats() {
    return { subscriptions: this.subscriptions.length, events: this.eventCount };
  }
}

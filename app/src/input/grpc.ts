// src/input/grpc.ts
import type { EventBus } from "../core/bus.js";
import type { AIRequestMessage, AIStreamMessage } from "../core/types.js";
import { log } from "../logger/index.js";

export class GrpcInputAdapter {
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  async processMessage(prompt: string, clientId: string, target?: string): Promise<string> {
    // If target specified, use it as the session ID directly.
    // Otherwise, derive from clientId or fall back to main.
    const sessionId = target
      ? target
      : clientId ? `grpc-${clientId}` : "main";

    return new Promise<string>((resolve, reject) => {
      const unsubs: Array<() => void> = [];
      const timeout = setTimeout(() => {
        unsubs.forEach(u => u());
        reject(new Error("Timeout waiting for response"));
      }, 120000);

      unsubs.push(this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
        if (msg.target !== sessionId) return;
        switch (msg.event) {
          case "complete":
            clearTimeout(timeout);
            unsubs.forEach(u => u());
            resolve(msg.text ?? "");
            break;
          case "error":
            clearTimeout(timeout);
            unsubs.forEach(u => u());
            reject(new Error(msg.error));
            break;
        }
      }));

      this.bus.publish({
        channel: "ai.request",
        source: "grpc",
        target: sessionId,
        text: prompt,
      });

      log.info({ sessionId, target, promptLength: prompt.length }, "GrpcInput: published");
    });
  }
}

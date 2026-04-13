// src/input/hud-chat.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventBus } from "../core/bus.js";
import type { AIRequestMessage, AIStreamMessage } from "../core/types.js";
import { log } from "../logger/index.js";

const DEFAULT_SESSION = "main";

export class HudChatAdapter {
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { prompt, sessionId } = JSON.parse(body);
        const sid = sessionId ?? DEFAULT_SESSION;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const unsubs: Array<() => void> = [];

        unsubs.push(this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
          if (msg.target !== sid) return;
          switch (msg.event) {
            case "delta":
              res.write(`data: ${JSON.stringify({ type: "delta", text: msg.text })}\n\n`);
              break;
            case "complete":
              res.write(`data: ${JSON.stringify({ type: "done", fullText: msg.text })}\n\n`);
              res.end();
              unsubs.forEach(u => u());
              break;
            case "error":
              res.write(`data: ${JSON.stringify({ type: "error", error: msg.error })}\n\n`);
              res.end();
              unsubs.forEach(u => u());
              break;
          }
        }));

        req.on("close", () => { unsubs.forEach(u => u()); });

        this.bus.publish({
          channel: "ai.request",
          source: "hud-chat",
          target: sid,
          text: prompt,
        });

      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }
}

// src/ai/openai/metrics-hud.ts
import type { EventBus } from "../../core/bus.js";
import type { SystemEventMessage } from "../../core/types.js";
import type { Piece } from "../../core/piece.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

export class OpenAIMetricsHud implements Piece {
  readonly id = "openai-metrics";
  readonly name = "OpenAI Usage";

  private bus!: EventBus;
  private unsub?: () => void;
  private promptTokens = 0;
  private completionTokens = 0;
  private requestCount = 0;
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.unsub = this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "api.usage") return;
      const d = msg.data;
      const reqPrompt = (d.input_tokens as number) ?? 0;
      const reqCompletion = (d.output_tokens as number) ?? 0;
      this.promptTokens += reqPrompt;
      this.completionTokens += reqCompletion;
      this.lastPromptTokens = reqPrompt;
      this.lastCompletionTokens = reqCompletion;
      this.requestCount++;

      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: this.getData(),
        status: "running",
      });
    });

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: "running",
        data: this.getData(),
        position: { x: 1660, y: 100 },
        size: { width: 280, height: 200 },
      },
    });

    log.info("OpenAIMetricsHud: started");
  }

  async stop(): Promise<void> {
    if (this.unsub) this.unsub();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("OpenAIMetricsHud: stopped");
  }

  getData(): Record<string, unknown> {
    return {
      model: config.model,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      requestCount: this.requestCount,
      lastPrompt: this.lastPromptTokens,
      lastCompletion: this.lastCompletionTokens,
    };
  }
}

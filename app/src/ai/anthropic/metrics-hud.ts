// src/ai/anthropic/metrics-hud.ts
import type { EventBus } from "../../core/bus.js";
import type { SystemEventMessage } from "../../core/types.js";
import type { Piece } from "../../core/piece.js";
import { config, getMaxContext } from "../../config/index.js";
import type { AnthropicSessionFactory } from "./factory.js";
import { log } from "../../logger/index.js";

export class AnthropicMetricsHud implements Piece {
  readonly id = "token-counter";
  readonly name = "Anthropic Usage";

  private bus!: EventBus;
  private unsubs: Array<() => void> = [];
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheCreation = 0;
  private cacheRead = 0;
  private requestCount = 0;
  private lastRequestTokens = 0;
  private lastCacheRead = 0;
  private lastCacheCreate = 0;
  private compactionCount = 0;
  private lastCompactionEngine: string | null = null;
  private factory: AnthropicSessionFactory;

  constructor(factory: AnthropicSessionFactory) {
    this.factory = factory;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "api.usage") return;
      const d = msg.data;
      const reqInput = (d.input_tokens as number) ?? 0;
      const reqCacheCreate = (d.cache_creation_input_tokens as number) ?? 0;
      const reqCacheRead = (d.cache_read_input_tokens as number) ?? 0;
      this.inputTokens += reqInput;
      this.outputTokens += (d.output_tokens as number) ?? 0;
      this.cacheCreation += reqCacheCreate;
      this.cacheRead += reqCacheRead;
      this.lastRequestTokens = reqInput + reqCacheCreate + reqCacheRead;
      this.lastCacheRead = reqCacheRead;
      this.lastCacheCreate = reqCacheCreate;
      this.requestCount++;
      log.debug({
        in: d.input_tokens, out: d.output_tokens,
        cacheNew: d.cache_creation_input_tokens, cacheHit: d.cache_read_input_tokens,
      }, "AnthropicMetrics: recorded");

      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: this.getData(),
        status: "running",
      });
    }));

    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "compaction") return;
      this.compactionCount++;
      this.lastCompactionEngine = (msg.data.engine as string) ?? null;
      log.info({ count: this.compactionCount, engine: this.lastCompactionEngine }, "AnthropicMetrics: compaction recorded");

      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data: this.getData(),
        status: "running",
      });
    }));

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
        size: { width: 280, height: 260 },
      },
    });

    log.info("AnthropicMetricsHud: started");
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("AnthropicMetricsHud: stopped");
  }

  getData(): Record<string, unknown> {
    const maxContext = getMaxContext();
    const cachePct = this.lastRequestTokens > 0 ? this.lastCacheRead / this.lastRequestTokens : 0;
    const contextPct = this.lastRequestTokens / maxContext;
    const breakdown = this.factory.getTokenBreakdown();
    const messagesEstimate = Math.max(0, this.lastRequestTokens - breakdown.systemTokens - breakdown.toolsTokens);
    return {
      model: config.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheCreation: this.cacheCreation,
      cacheRead: this.cacheRead,
      cachePct,
      contextPct,
      maxContext,
      requestCount: this.requestCount,
      systemTokens: breakdown.systemTokens,
      toolsTokens: breakdown.toolsTokens,
      messagesTokens: messagesEstimate,
      compactionCount: this.compactionCount,
      lastCompactionEngine: this.lastCompactionEngine,
    };
  }
}

// src/ai/anthropic/metrics-hud.ts
import type { EventBus } from "../../core/bus.js";
import type { AIStreamMessage, SystemEventMessage } from "../../core/types.js";
import type { Piece } from "../../core/piece.js";
import { config, getMaxContext } from "../../config/index.js";
import type { AnthropicSessionFactory } from "./factory.js";
import { log } from "../../logger/index.js";

const STREAMING_VERBS = [
  "Analyzing", "Bloviating", "Cogitating", "Deliberating", "Elaborating",
  "Formulating", "Generating", "Hypothesizing", "Inferring", "Juggling",
  "Kernelizing", "Lucubrating", "Musing", "Noodling", "Orchestrating",
  "Pontificating", "Quantifying", "Reasoning", "Synthesizing", "Transmuting",
];

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

  // Streaming state
  private streamingActive = false;
  private streamingStartMs = 0;
  private streamingVerb = "";
  private streamingOutputChars = 0;
  private streamingTimer: ReturnType<typeof setInterval> | null = null;

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

      this.pushHudUpdate();
    }));

    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "compaction") return;
      this.compactionCount++;
      this.lastCompactionEngine = (msg.data.engine as string) ?? null;
      log.info({ count: this.compactionCount, engine: this.lastCompactionEngine }, "AnthropicMetrics: compaction recorded");
      this.pushHudUpdate();
    }));

    // Track streaming state from ai.stream events (main session only)
    this.unsubs.push(this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
      if (msg.target !== "main") return;

      switch (msg.event) {
        case "delta":
          if (!this.streamingActive) {
            this.streamingActive = true;
            this.streamingStartMs = Date.now();
            this.streamingOutputChars = 0;
            this.streamingVerb = STREAMING_VERBS[Math.floor(Math.random() * STREAMING_VERBS.length)];
            this.startStreamingTimer();
          }
          this.streamingOutputChars += (msg.text ?? "").length;
          break;

        case "tool_start":
          // Tools starting — pause streaming display, keep timer for elapsed
          if (!this.streamingActive) {
            this.streamingActive = true;
            this.streamingStartMs = Date.now();
            this.streamingOutputChars = 0;
            this.streamingVerb = "Executing";
            this.startStreamingTimer();
          }
          break;

        case "complete":
        case "error":
        case "aborted":
          this.streamingActive = false;
          this.stopStreamingTimer();
          this.pushHudUpdate();
          break;
      }
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
        size: { width: 280, height: 280 },
      },
    });

    log.info("AnthropicMetricsHud: started");
  }

  async stop(): Promise<void> {
    this.stopStreamingTimer();
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

  private startStreamingTimer(): void {
    if (this.streamingTimer) return;
    this.streamingTimer = setInterval(() => {
      this.pushHudUpdate();
    }, 1000);
  }

  private stopStreamingTimer(): void {
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
  }

  private pushHudUpdate(): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: "running",
    });
  }

  getData(): Record<string, unknown> {
    const maxContext = getMaxContext();
    const cachePct = this.lastRequestTokens > 0 ? this.lastCacheRead / this.lastRequestTokens : 0;
    const contextPct = this.lastRequestTokens / maxContext;

    // Use real API cache values for system+tools estimate instead of char-count heuristic.
    // cache_read + cache_creation = tokens covered by prompt caching (system prompt + tools).
    // input_tokens (non-cached) ≈ messages tokens (conversation history).
    const cachedTokens = this.lastCacheRead + this.lastCacheCreate;
    const nonCachedInput = Math.max(0, this.lastRequestTokens - cachedTokens);

    // Split cached portion into system vs tools using char-ratio as proportional guide only
    const breakdown = this.factory.getTokenBreakdown();
    const charTotal = breakdown.systemTokens + breakdown.toolsTokens;
    const systemRatio = charTotal > 0 ? breakdown.systemTokens / charTotal : 0.6;
    const systemTokens = cachedTokens > 0 ? Math.round(cachedTokens * systemRatio) : breakdown.systemTokens;
    const toolsTokens = cachedTokens > 0 ? cachedTokens - systemTokens : breakdown.toolsTokens;
    const messagesTokens = nonCachedInput;

    return {
      model: config.model,
      // Session accumulated totals
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      sessionInputTokens: this.inputTokens,
      sessionOutputTokens: this.outputTokens,
      cacheCreation: this.cacheCreation,
      cacheRead: this.cacheRead,
      cachePct,
      // Context snapshot (current window usage from last request)
      contextTokens: this.lastRequestTokens,
      contextPct,
      maxContext,
      requestCount: this.requestCount,
      systemTokens,
      toolsTokens,
      messagesTokens,
      compactionCount: this.compactionCount,
      lastCompactionEngine: this.lastCompactionEngine,
      // Streaming state — startMs is stable (doesn't change per tick), elapsed computed by frontend
      streaming: this.streamingActive,
      streamingVerb: this.streamingVerb,
      streamingStartMs: this.streamingActive ? this.streamingStartMs : 0,
      streamingOutputChars: this.streamingOutputChars,
    };
  }
}

// src/core/jarvis.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { EventBus } from "./bus.js";
import type { SessionManager } from "./session-manager.js";
import { consumeStartupPrompt } from "./conversation-store.js";
import type {
  AIRequestMessage,
  AIStreamMessage,
  CapabilityRequestMessage,
  CapabilityResultMessage,
  SystemEventMessage,
  HudUpdateMessage,
} from "./types.js";
import type { AIStreamEvent, CapabilityCall } from "../ai/types.js";
import type { Piece } from "./piece.js";
import { log } from "../logger/index.js";
import { config } from "../config/index.js";
import { graphRegistry } from "./graph-registry.js";

function summarizeToolArgs(input: Record<string, unknown>): string {
  const { __sessionId: _, ...args } = input;
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const val = typeof v === "string" ? v
        : typeof v === "number" || typeof v === "boolean" ? String(v)
        : JSON.stringify(v);
      // For single-arg tools, just show the value
      if (entries.length === 1) return val;
      // For multi-arg, show key=value
      return `${k}=${val}`;
    })
    .join(" ");
}

function shortenToolName(name: string): string {
  // mcp__knowledge-semantic__knowledge_search → knowledge_search
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1];
  }
  return name;
}

export class JarvisCore implements Piece {
  readonly id = "jarvis-core";
  readonly name = "Jarvis Core";

  private bus!: EventBus;
  private sessions: SessionManager;
  private totalRequests = 0;
  private lastResponseMs = 0;
  private globalState: "loading" | "online" | "processing" | "waiting_tools" = "loading";
  private sessionStates = new Map<string, "idle" | "processing" | "waiting_tools">();
  private pendingPrompts = new Map<string, AIRequestMessage[]>();
  private pendingReplyTo = new Map<string, string>(); // sessionId → replyTo (caller session)
  private jarvisMdPath = join(homedir(), ".jarvis", "jarvis.md");

  /** Session ownership: JarvisCore only processes sessions it owns.
   *  Default: "main" and "grpc-*". Plugins can register additional patterns. */
  private ownedPatterns: Array<string | RegExp> = ["main", /^grpc-/];

  /** Check if a session ID belongs to this core instance */
  private isOwnedSession(sessionId: string): boolean {
    return this.ownedPatterns.some(p =>
      typeof p === "string" ? p === sessionId : p.test(sessionId)
    );
  }

  /** Register an additional session pattern that JarvisCore should manage.
   *  Accepts exact string or RegExp. */
  registerSessionPattern(pattern: string | RegExp): void {
    this.ownedPatterns.push(pattern);
    log.info({ pattern: String(pattern) }, "JarvisCore: registered session pattern");
  }

  systemContext(): string {
    // jarvis.md is now injected as the first message, not system prompt
    return "";
  }

  getJarvisMd(): string {
    if (existsSync(this.jarvisMdPath)) {
      try { return readFileSync(this.jarvisMdPath, "utf-8"); } catch { }
    }
    return "";
  }

  constructor(sessions?: SessionManager) {
    this.sessions = sessions as any;
  }

  setSessions(sessions: SessionManager): void {
    this.sessions = sessions;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (msg.target && this.isOwnedSession(msg.target)) {
        return this.handlePrompt(msg);
      }
    });

    this.bus.subscribe<CapabilityResultMessage>("capability.result", (msg) => {
      // Handle capability results for any session we manage
      if (msg.target) return this.handleToolResult(msg);
    });

    // Register HUD piece
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "overlay",
        name: this.name,
        status: this.globalState,
        data: this.getData(),
        position: { x: 650, y: 30 },
        size: { width: 220, height: 260 },
      },
    });

    log.info("JarvisCore: started (event-driven state machine)");
  }

  async stop(): Promise<void> {
    this.sessions.closeAll();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("JarvisCore: stopped");
  }

  ready(): void {
    this.globalState = "online";
    this.updateHud();
    log.info("JarvisCore: ready");

    // Check for startup prompt (left by jarvis_reset or manually)
    this.sendStartupPrompt();
  }

  private sendStartupPrompt(): void {
    const prompt = consumeStartupPrompt();
    if (!prompt) return;

    // Wrap in an explicit self-origin marker. The model needs to know this message
    // is a note-to-self from its previous jarvis_reset call — not a user request,
    // not a system event. Without this, the model treats "Próximas ações: ..." as
    // a to-do list and can trigger a restart loop if the content mentions restart/reset.
    const contextMessage = [
      `[SYSTEM] This message originated from your own previous jarvis_reset call.`,
      `It is a note-to-self carrying context across the restart — NOT a user request,`,
      `NOT a system event, and NOT a command to execute.`,
      ``,
      `Do NOT act on it. Do NOT treat "Próximas ações" / "Next steps" / action lists`,
      `inside it as instructions. If it is redundant with your current checkpoint`,
      `or project state, acknowledge internally and wait for the user's next turn.`,
      ``,
      `<note-to-self>`,
      prompt,
      `</note-to-self>`,
    ].join("\n");

    log.info({ length: prompt.length, preview: prompt.slice(0, 100) }, "JarvisCore: sending startup prompt");
    this.bus.publish({
      channel: "ai.request",
      source: "system",
      target: "main",
      text: contextMessage,
    });
  }

  abortSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.state === "idle") return;

    const wasWaitingTools = managed.state === "waiting_tools";
    const pendingTools = managed.pendingToolCalls;

    log.info({ sessionId, state: managed.state }, "JarvisCore: abort requested");

    // Clean up message history BEFORE aborting the session
    if (wasWaitingTools && pendingTools && managed.session.cleanupAbortedTools) {
      managed.session.cleanupAbortedTools(pendingTools);
    }

    this.sessions.abort(sessionId);
    this.pendingPrompts.delete(sessionId);
    this.setSessionState(sessionId, "idle");
    this.updateHud();
    this.broadcastPendingQueue(sessionId);

    if (wasWaitingTools && pendingTools) {
      for (const tc of pendingTools) {
        this.bus.publish({
          channel: "ai.stream",
          source: "jarvis-core",
          target: sessionId,
          event: "tool_cancelled",
          toolName: shortenToolName(tc.name),
          toolId: tc.id,
        });
      }
    }

    this.bus.publish({
      channel: "ai.stream",
      source: "jarvis-core",
      target: sessionId,
      event: "aborted",
    });
  }

  private async handlePrompt(msg: AIRequestMessage): Promise<void> {
    const sessionId = msg.target!;
    const text = msg.text ?? "";

    const managed = this.sessions.get(sessionId);

    if (managed.state !== "idle") {
      // Queue the message — it will be drained after the current operation finishes.
      // Never abort a running operation just because a new message arrived.
      // Only explicit user abort (ESC / abort button) should interrupt processing.
      if (!this.pendingPrompts.has(sessionId)) {
        this.pendingPrompts.set(sessionId, []);
      }
      this.pendingPrompts.get(sessionId)!.push(msg);
      log.info({ sessionId, state: managed.state, queueSize: this.pendingPrompts.get(sessionId)!.length }, "JarvisCore: queued prompt (session busy)");
      this.broadcastPendingQueue(sessionId);
      return;
    }

    // Track replyTo so we can route the response back to the caller
    if (msg.replyTo) {
      this.pendingReplyTo.set(sessionId, msg.replyTo);
    } else {
      this.pendingReplyTo.delete(sessionId);
    }

    this.sessions.setState(sessionId, "processing");
    this.setSessionState(sessionId, "processing");
    this.updateHud();
    const t0 = Date.now();
    log.info({ sessionId, prompt: text.slice(0, 80), images: msg.images?.length ?? 0, replyTo: msg.replyTo }, "JarvisCore: processing");

    try {
      const images = msg.images?.map(i => ({ label: i.label, base64: i.base64, mediaType: i.mediaType }));
      const stream = managed.session.sendAndStream(text, images);
      await this.consumeStream(sessionId, stream);
    } catch (err) {
      this.sessions.setState(sessionId, "idle");
      this.setSessionState(sessionId, "idle");
      this.updateHud();
      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "error",
        error: String(err),
      });
      log.error({ sessionId, err }, "JarvisCore: failed");
    }

    this.lastResponseMs = Date.now() - t0;
    this.totalRequests++;
    // Derive correct state from all sessions instead of blindly setting "online"
    this.deriveGlobalState();
    this.updateHud();
  }

  private async handleToolResult(msg: CapabilityResultMessage): Promise<void> {
    const sessionId = msg.target!;
    const results = msg.results;
    const managed = this.sessions.get(sessionId);

    if (managed.state !== "waiting_tools") {
      log.warn({ sessionId }, "JarvisCore: tool result but not waiting");
      return;
    }

    const pendingCalls = managed.pendingToolCalls;
    if (!pendingCalls) {
      log.error({ sessionId }, "JarvisCore: no pending tool calls");
      return;
    }

    managed.session.addToolResults(pendingCalls, results);

    // Notify chat of tool completion with output preview
    for (const tc of pendingCalls) {
      const result = results.find(r => r.tool_use_id === tc.id);
      const rawOutput = result
        ? typeof result.content === "string" ? result.content : JSON.stringify(result.content)
        : "";
      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "tool_done",
        toolName: shortenToolName(tc.name),
        toolId: tc.id,
        toolOutput: rawOutput,
      });
    }

    managed.pendingToolCalls = undefined;
    this.sessions.setState(sessionId, "processing");
    this.setSessionState(sessionId, "processing");
    this.updateHud();

    try {
      const stream = managed.session.continueAndStream();
      await this.consumeStream(sessionId, stream);
    } catch (err) {
      this.sessions.setState(sessionId, "idle");
      this.setSessionState(sessionId, "idle");
      this.updateHud();
      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "error",
        error: String(err),
      });
      log.error({ sessionId, err }, "JarvisCore: tool continuation failed");
    }
  }

  private async consumeStream(
    sessionId: string,
    stream: AsyncGenerator<AIStreamEvent, void>,
  ): Promise<void> {
    let fullText = "";
    const toolCalls: CapabilityCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          fullText += event.text ?? "";
          this.bus.publish({
            channel: "ai.stream",
            source: "jarvis-core",
            target: sessionId,
            event: "delta",
            text: event.text ?? "",
          });
          break;
        case "tool_use":
          if (event.toolUse) toolCalls.push(event.toolUse);
          break;
        case "message_complete":
          usage = event.usage;
          break;
        case "compaction":
          if (event.compaction) {
            this.bus.publish({
              channel: "ai.stream",
              source: "jarvis-core",
              target: sessionId,
              event: "compaction",
              compaction: event.compaction,
            } as any);

            this.bus.publish({
              channel: "system.event",
              source: "jarvis-core",
              event: "compaction",
              data: {
                sessionId,
                engine: event.compaction.engine,
                tokensBefore: event.compaction.tokensBefore,
                tokensAfter: event.compaction.tokensAfter,
                summaryLength: event.compaction.summary.length,
              },
            });

            log.info({
              sessionId,
              engine: event.compaction.engine,
              tokensBefore: event.compaction.tokensBefore,
              tokensAfter: event.compaction.tokensAfter,
            }, "JarvisCore: context compacted");
          }
          break;
        case "error":
          if (event.error !== "aborted") {
            log.error({ sessionId, error: event.error }, "JarvisCore: stream error");
          }
          break;
      }
    }

    if (usage) {
      this.bus.publish({
        channel: "system.event",
        source: "jarvis-core",
        event: "api.usage",
        data: {
          sessionId,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: (usage as any).cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: (usage as any).cache_read_input_tokens ?? 0,
          model: config.model,
        },
      });
    }

    if (toolCalls.length > 0) {
      const managed = this.sessions.get(sessionId);
      managed.pendingToolCalls = toolCalls;
      this.sessions.setState(sessionId, "waiting_tools");
      this.setSessionState(sessionId, "waiting_tools");
      this.updateHud();

      // Notify chat of tool execution start
      for (const tc of toolCalls) {
        this.bus.publish({
          channel: "ai.stream",
          source: "jarvis-core",
          target: sessionId,
          event: "tool_start",
          toolName: shortenToolName(tc.name),
          toolId: tc.id,
          toolArgs: summarizeToolArgs(tc.input),
        });
      }

      this.bus.publish({
        channel: "capability.request",
        source: "jarvis-core",
        target: sessionId,
        calls: toolCalls,
      });
    } else {
      this.sessions.setState(sessionId, "idle");
      this.setSessionState(sessionId, "idle");
      this.updateHud();
      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "complete",
        text: fullText,
        usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      });

      // Route response back to the calling session if replyTo is set
      const replyTo = this.pendingReplyTo.get(sessionId);
      if (replyTo && fullText) {
        this.pendingReplyTo.delete(sessionId);
        log.info({ sessionId, replyTo, textLength: fullText.length }, "JarvisCore: routing response to replyTo");
        this.bus.publish({
          channel: "ai.request",
          source: "jarvis-core",
          target: replyTo,
          text: `[JARVIS] ${fullText}`,
        } as Parameters<EventBus["publish"]>[0]);
      }

      // Drain queued prompts for this session
      this.drainQueue(sessionId);
    }
  }

  private drainQueue(sessionId: string): void {
    const queue = this.pendingPrompts.get(sessionId);
    if (!queue || queue.length === 0) return;

    // Take all queued messages — combine text and collect images
    const combined = queue.map(m => m.text ?? "").join("\n\n");
    const allImages = queue.flatMap(m => (m as any).images ?? []);
    queue.length = 0;
    this.broadcastPendingQueue(sessionId);

    log.info({ sessionId, combinedLength: combined.length, images: allImages.length }, "JarvisCore: draining queued prompts");

    // Process as a new prompt (async, fire and forget)
    this.handlePrompt({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      channel: "ai.request",
      source: "queue-drain",
      target: sessionId,
      text: combined,
      ...(allImages.length > 0 ? { images: allImages } : {}),
    } as AIRequestMessage);
  }

  /**
   * Broadcast the current pending queue snapshot for a session over the SSE
   * channel. Frontend uses this to render the "queued messages" list under
   * the JARVIS thinking indicator.
   */
  private broadcastPendingQueue(sessionId: string): void {
    const queue = this.pendingPrompts.get(sessionId) ?? [];
    const items = queue.map(msg => ({
      text: (msg.text ?? "").slice(0, 280),
      source: msg.source,
      hasImages: Array.isArray((msg as any).images) && (msg as any).images.length > 0,
    }));
    this.bus.publish({
      channel: "ai.stream",
      source: "jarvis-core",
      target: sessionId,
      event: "pending_queue",
      items,
    } as any);
  }

  /** Derive global state from all tracked per-session states */
  private deriveGlobalState(): void {
    const prev = this.globalState;
    if (this.sessionStates.size === 0) {
      this.globalState = "online";
    } else {
      const states = [...this.sessionStates.values()];
      if (states.includes("waiting_tools")) {
        this.globalState = "waiting_tools";
      } else if (states.includes("processing")) {
        this.globalState = "processing";
      } else {
        this.globalState = "online";
      }
    }
    // Keep graphRegistry in sync so the core-node tree reflects live state
    if (this.globalState !== prev) {
      graphRegistry.update("jarvis-core", { status: this.globalState });
    }
  }

  private setSessionState(sessionId: string, state: "idle" | "processing" | "waiting_tools"): void {
    if (state === "idle") {
      this.sessionStates.delete(sessionId);
    } else {
      this.sessionStates.set(sessionId, state);
    }
    this.deriveGlobalState();
  }

  getData(): Record<string, unknown> {
    return {
      status: this.globalState,
      coreLabel: this.globalState.toUpperCase().replace("_", " "),
      totalRequests: this.totalRequests,
      lastResponseMs: this.lastResponseMs,
      activeSessions: this.sessions.size,
    };
  }

  private updateHud(): void {
    if (!this.bus) return;
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: this.globalState,
    });
  }
}

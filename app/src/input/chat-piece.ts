// src/input/chat-piece.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { AIRequestMessage, AIStreamMessage, HudUpdateMessage } from "../core/types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { log } from "../logger/index.js";

const DEFAULT_SESSION = "main";

export class ChatPiece implements Piece {
  readonly id = "chat";
  readonly name = "Chat";

  private bus!: EventBus;
  private registry?: CapabilityRegistry;
  private streamClients = new Set<ServerResponse>();

  setRegistry(registry: CapabilityRegistry): void {
    this.registry = registry;
  }

  systemContext(): string {
    return `## Chat Piece
The user interacts via a chat panel in the HUD (Electron window). Text input at the bottom, messages displayed above.
Your text responses are shown in the chat panel. Additional I/O available via plugins.`;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Subscribe to AI stream — unified timeline for all non-actor sessions
    this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
      if (msg.target?.startsWith("actor-")) return;
      const source = msg.source === "jarvis-core" ? "jarvis" : msg.source;
      switch (msg.event) {
        case "delta":
          this.broadcast({ type: "delta", text: msg.text, source, session: msg.target });
          break;
        case "complete":
          this.broadcast({ type: "done", fullText: msg.text ?? "", source, session: msg.target });
          break;
        case "error":
          this.broadcast({ type: "error", error: msg.error, source, session: msg.target });
          break;
        case "tool_start":
          this.broadcast({ type: "tool_start", name: msg.toolName, id: msg.toolId, args: msg.toolArgs, source, session: msg.target });
          break;
        case "tool_done":
          this.broadcast({ type: "tool_done", name: msg.toolName, id: msg.toolId, ms: msg.toolMs, output: msg.toolOutput, source, session: msg.target });
          break;
        case "tool_cancelled":
          this.broadcast({ type: "tool_cancelled", name: msg.toolName, id: msg.toolId, source, session: msg.target });
          break;
        case "aborted":
          this.broadcast({ type: "aborted", source, session: msg.target });
          break;
        case "compaction":
          this.broadcast({
            type: "compaction",
            engine: (msg as any).compaction?.engine,
            tokensBefore: (msg as any).compaction?.tokensBefore,
            tokensAfter: (msg as any).compaction?.tokensAfter,
            summary: (msg as any).compaction?.summary,
            source,
            session: msg.target,
          });
          break;
      }
    });

    // Show user prompts from all non-actor sessions
    this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (msg.target?.startsWith("actor-")) return;
      if (msg.source === "chat-input") return; // already shown via handleSend
      // Identify source label
      let source = msg.source;
      if (msg.source === "grpc") source = "grpc";
      else if (msg.source === "actor-pool") source = "actor";
      else if (msg.source === "queue-drain") source = "system";
      // plugins and other sources use their source as-is
      this.broadcast({ type: "user", text: msg.text, source, session: msg.target });
    });

    // Register two HUD pieces
    this.bus.publish({
      channel: "hud.update", source: this.id, action: "add", pieceId: "chat-output",
      piece: { pieceId: "chat-output", type: "panel", name: "Chat", status: "running", data: {},
        position: { x: 10, y: 480 }, size: { width: 1660, height: 280 } },
    });

    this.bus.publish({
      channel: "hud.update", source: this.id, action: "add", pieceId: "chat-input",
      piece: { pieceId: "chat-input", type: "panel", name: "Input", status: "running", data: {},
        position: { x: 10, y: 768 }, size: { width: 1660, height: 44 } },
    });

    log.info("ChatPiece: started");
  }

  async stop(): Promise<void> {
    for (const res of this.streamClients) { try { res.end(); } catch {} }
    this.streamClients.clear();

    this.bus.publish({
      channel: "hud.update", source: this.id, action: "remove", pieceId: "chat-output",
    });
    this.bus.publish({
      channel: "hud.update", source: this.id, action: "remove", pieceId: "chat-input",
    });
    log.info("ChatPiece: stopped");
  }

  // HTTP handler for POST /chat/send — fire and forget, just publishes ai.request
  handleSend(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      try {
        const { prompt, images } = JSON.parse(body);

        // Intercept slash commands (e.g. /skill-name args)
        if (this.registry && typeof prompt === "string" && prompt.startsWith("/")) {
          const match = prompt.match(/^\/(\S+)\s*(.*)?$/);
          if (match) {
            const [, cmdName, cmdArgs] = match;
            const slashCmd = this.registry.getSlashCommand(cmdName);
            if (slashCmd) {
              this.broadcast({ type: "user", text: prompt, source: "chat" });
              slashCmd.handler(cmdArgs?.trim() ?? "").then((result) => {
                if (result.message) {
                  this.broadcast({ type: "done", fullText: result.message, source: "system" });
                }
                if (result.inject) {
                  // Inject triggers systemContext() rebuild on next AI request — no action needed here
                  log.info({ cmd: cmdName, injectLength: result.inject.length }, "ChatPiece: slash command injected content");
                }
              }).catch((err) => {
                this.broadcast({ type: "error", error: `Slash command error: ${err}`, source: "system" });
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
              return;
            }
          }
        }

        // Normal message — broadcast and send to AI
        this.broadcast({ type: "user", text: prompt, images, source: "chat" });
        this.bus.publish({
          channel: "ai.request",
          source: "chat-input",
          target: DEFAULT_SESSION,
          text: prompt,
          images,
        } as any);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  // HTTP handler for POST /chat — streams SSE response (legacy, for direct consumers)
  handleChat(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { prompt } = JSON.parse(body);

        // Broadcast user message to output panel
        this.broadcast({ type: "user", text: prompt });

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

        const unsubs: Array<() => void> = [];

        unsubs.push(this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
          if (msg.target !== DEFAULT_SESSION) return;
          switch (msg.event) {
            case "delta":
              res.write(`data: ${JSON.stringify({ type: "delta", text: msg.text })}\n\n`);
              break;
            case "complete":
              log.info("ChatPiece: handleChat stream complete received, ending response");
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
          source: "chat-input",
          target: DEFAULT_SESSION,
          text: prompt,
        });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  // SSE endpoint for chat output panel — /chat-stream
  handleStream(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    this.streamClients.add(res);
    _req.on("close", () => { this.streamClients.delete(res); });
  }

  /** Broadcast a system event to all connected SSE clients */
  broadcastEvent(data: Record<string, unknown>): void {
    this.broadcast(data);
  }

  private broadcast(data: Record<string, unknown>): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.streamClients) {
      try { client.write(msg); } catch {}
    }
  }
}

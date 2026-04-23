// src/input/chat-piece.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { AIRequestMessage, AIStreamMessage, HudUpdateMessage } from "../core/types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { SessionManager } from "../core/session-manager.js";
import { log } from "../logger/index.js";

/**
 * ChatPiece — session-agnostic chat bridge.
 *
 * The core chat piece does NOT know about "main", "actor-*" or any specific
 * session id. It receives a sessionId as an opaque string on every request and
 * routes SSE clients, history lookups and ai.request publishes to/for that
 * exact session id.
 *
 * SSE multiplexing: one pool of clients per sessionId. An ai.stream event only
 * reaches the pool whose sessionId matches msg.target.
 *
 * Required payload on every HTTP endpoint:
 *  - POST /chat/send         → body { sessionId, prompt, images? }
 *  - GET  /chat-stream       → query ?sessionId=X
 *  - GET  /chat/history      → query ?sessionId=X
 *  - POST /chat/abort        → body { sessionId }
 *  - POST /chat/clear-session→ body { sessionId }
 *  - POST /chat/compact      → body { sessionId }
 *
 * Missing or empty sessionId → HTTP 400.
 */
export class ChatPiece implements Piece {
  readonly id = "chat";
  readonly name = "Chat";

  private bus!: EventBus;
  private registry?: CapabilityRegistry;
  private sessions?: SessionManager;

  /** SSE clients keyed by sessionId. Events only reach matching pools. */
  private streamClients = new Map<string, Set<ServerResponse>>();

  setRegistry(registry: CapabilityRegistry): void {
    this.registry = registry;
  }

  setSessions(sessions: SessionManager): void {
    this.sessions = sessions;
  }

  systemContext(): string {
    return `## Chat Piece
The user interacts via a chat panel in the HUD (Electron window). Text input at the bottom, messages displayed above.
Your text responses are shown in the chat panel. Additional I/O available via plugins.`;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Route ai.stream events to the SSE pool of their target sessionId
    this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
      if (!msg.target) return;
      const source = msg.source === "jarvis-core" ? "jarvis" : msg.source;
      switch (msg.event) {
        case "delta":
          this.broadcast(msg.target, { type: "delta", text: msg.text, source, session: msg.target });
          break;
        case "complete":
          this.broadcast(msg.target, { type: "done", fullText: msg.text ?? "", source, session: msg.target });
          break;
        case "error":
          this.broadcast(msg.target, { type: "error", error: msg.error, source, session: msg.target });
          break;
        case "tool_start":
          this.broadcast(msg.target, { type: "tool_start", name: msg.toolName, id: msg.toolId, args: msg.toolArgs, source, session: msg.target });
          break;
        case "tool_done":
          this.broadcast(msg.target, { type: "tool_done", name: msg.toolName, id: msg.toolId, ms: msg.toolMs, output: msg.toolOutput, source, session: msg.target });
          break;
        case "tool_cancelled":
          this.broadcast(msg.target, { type: "tool_cancelled", name: msg.toolName, id: msg.toolId, source, session: msg.target });
          break;
        case "aborted":
          this.broadcast(msg.target, { type: "aborted", source, session: msg.target });
          break;
        case "compaction":
          this.broadcast(msg.target, {
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

    // Mirror user prompts into the SSE pool of their target session
    this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (!msg.target) return;
      if (msg.source === "chat-input") return; // already broadcast by handleSend
      let source = msg.source;
      if (msg.source === "grpc") source = "grpc";
      else if (msg.source === "queue-drain") source = "system";
      this.broadcast(msg.target, { type: "user", text: msg.text, source, session: msg.target });
    });

    // Register HUD panels for the root chat (main session lives in App.tsx)
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
    for (const clients of this.streamClients.values()) {
      for (const res of clients) { try { res.end(); } catch {} }
    }
    this.streamClients.clear();

    this.bus.publish({
      channel: "hud.update", source: this.id, action: "remove", pieceId: "chat-output",
    });
    this.bus.publish({
      channel: "hud.update", source: this.id, action: "remove", pieceId: "chat-input",
    });
    log.info("ChatPiece: stopped");
  }

  // ────────────── Helpers ──────────────

  private parseQuerySessionId(req: IncomingMessage): string | null {
    const url = req.url ?? "";
    const idx = url.indexOf("?");
    if (idx < 0) return null;
    const params = new URLSearchParams(url.slice(idx + 1));
    const v = params.get("sessionId");
    return v && v.trim() ? v.trim() : null;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private send400(res: ServerResponse, error: string): void {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  }

  // ────────────── HTTP handlers ──────────────

  /** POST /chat/send — body { sessionId, prompt, images? } */
  async handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string;
    try { body = await this.readBody(req); } catch (e) { return this.send400(res, String(e)); }

    let parsed: any;
    try { parsed = JSON.parse(body); } catch (e) { return this.send400(res, `Invalid JSON: ${e}`); }

    const sessionId: string | undefined = parsed.sessionId;
    if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
      return this.send400(res, "sessionId is required");
    }
    const sid = sessionId.trim();
    const prompt: string = parsed.prompt ?? "";
    const images = parsed.images;

    log.info({ sessionId: sid, prompt: typeof prompt === "string" ? prompt.slice(0, 200) : "<non-string>", hasImages: !!images?.length }, "ChatPiece: handleSend");

    // Intercept slash commands (only have semantics for the calling session)
    if (this.registry && typeof prompt === "string" && prompt.startsWith("/")) {
      const match = prompt.match(/^\/(\S+)\s*(.*)?$/);
      if (match) {
        const [, cmdName, cmdArgs] = match;
        const slashCmd = this.registry.getSlashCommand(cmdName);
        if (slashCmd) {
          this.broadcast(sid, { type: "user", text: prompt, source: "chat", session: sid });
          slashCmd.handler(cmdArgs?.trim() ?? "").then((result) => {
            if (result.message) this.broadcast(sid, { type: "done", fullText: result.message, source: "system", session: sid });
            if (result.inject) log.info({ cmd: cmdName, injectLength: result.inject.length }, "ChatPiece: slash command injected content");
          }).catch((err) => {
            this.broadcast(sid, { type: "error", error: `Slash command error: ${err}`, source: "system", session: sid });
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }
    }

    // Normal message
    this.broadcast(sid, { type: "user", text: prompt, images, source: "chat", session: sid });
    this.bus.publish({
      channel: "ai.request",
      source: "chat-input",
      target: sid,
      text: prompt,
      images,
    } as any);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  /** GET /chat-stream?sessionId=X — SSE pool scoped to sessionId. */
  handleStream(req: IncomingMessage, res: ServerResponse): void {
    const sid = this.parseQuerySessionId(req);
    if (!sid) { this.send400(res, "sessionId query param is required"); return; }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

    if (!this.streamClients.has(sid)) this.streamClients.set(sid, new Set());
    const pool = this.streamClients.get(sid)!;
    pool.add(res);

    req.on("close", () => {
      pool.delete(res);
      if (pool.size === 0) this.streamClients.delete(sid);
    });
  }

  /** GET /chat/history?sessionId=X — parsed session messages. */
  handleHistory(req: IncomingMessage, res: ServerResponse): void {
    const sid = this.parseQuerySessionId(req);
    if (!sid) { this.send400(res, "sessionId query param is required"); return; }

    try {
      if (!this.sessions) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      if (!this.sessions.has(sid)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      const managed = this.sessions.get(sid);
      const rawMessages = managed.session.getMessages() as any[];
      const entries = parseMessagesToHistory(rawMessages);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
  }

  /** Broadcast a system/UI event to a specific session's SSE pool.
   *  Note: this is used by main.ts (e.g. session_cleared). Plugins/components
   *  should publish on ai.stream/ai.request; those route automatically. */
  broadcastEvent(sessionId: string, data: Record<string, unknown>): void {
    if (!sessionId) return;
    this.broadcast(sessionId, data);
  }

  private broadcast(sessionId: string, data: Record<string, unknown>): void {
    const pool = this.streamClients.get(sessionId);
    if (!pool || pool.size === 0) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of pool) {
      try { client.write(msg); } catch {}
    }
  }
}

/** Parse raw session messages into chat timeline entries. Pure helper. */
export function parseMessagesToHistory(rawMessages: any[]): any[] {
  const entries: any[] = [];

  for (const msg of rawMessages) {
    if (msg.role === "user") {
      if (Array.isArray(msg.content) && msg.content.every((b: any) => b.type === "tool_result")) continue;
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") text += block.text;
        }
      }
      if (!text.trim()) continue;
      entries.push({ kind: "message", role: "user", text, source: "chat" });
    } else if (msg.role === "assistant") {
      let text = "";
      const toolUses: any[] = [];
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") text += block.text;
          if (block.type === "tool_use") toolUses.push(block);
        }
      }
      if (text) entries.push({ kind: "message", role: "assistant", text, source: "jarvis" });
      for (const tu of toolUses) {
        entries.push({
          kind: "capability",
          name: tu.name,
          id: tu.id,
          args: typeof tu.input === "object" ? JSON.stringify(tu.input) : String(tu.input ?? ""),
          status: "done",
        });
      }
    }
  }

  return entries;
}

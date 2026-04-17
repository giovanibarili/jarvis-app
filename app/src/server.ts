// src/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { ChatPiece } from "./input/chat-piece.js";
import { load as loadSettings, save as saveSettings } from "./core/settings.js";
import { log, getLogBuffer, onLogEntry } from "./logger/index.js";

const UI_DIST = join(process.cwd(), "ui", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

type HudStateProvider = () => Record<string, unknown>;
type CapabilitiesProvider = () => Array<{ name: string; description: string; category?: string }>;
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export class HttpServer {
  private server: ReturnType<typeof createServer>;
  private port: number;
  private chatPiece: ChatPiece;
  private getHudState: HudStateProvider;
  private getCapabilities?: CapabilitiesProvider;
  private rendererCache = new Map<string, { js: string; mtime: number }>();
  private pluginRoutes = new Map<string, RouteHandler>();
  private onAbort?: () => void;
  private onClearSession?: () => void;

  constructor(port: number, chatPiece: ChatPiece, getHudState: HudStateProvider, onAbort?: () => void, getCapabilities?: CapabilitiesProvider) {
    this.port = port;
    this.chatPiece = chatPiece;
    this.getHudState = getHudState;
    this.getCapabilities = getCapabilities;
    this.onAbort = onAbort;
    this.server = createServer(this.handle.bind(this));
    this.server.listen(port, () => log.info({ port }, "HttpServer: listening"));
  }

  setOnClearSession(handler: () => void): void {
    this.onClearSession = handler;
  }

  registerRoute(method: string, path: string, handler: RouteHandler): void {
    const key = `${method.toUpperCase()} ${path}`;
    this.pluginRoutes.set(key, handler);
    log.info({ method, path }, "HttpServer: plugin route registered");
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Required for ONNX Runtime WASM (SharedArrayBuffer)
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.url === "/chat/send" && req.method === "POST") {
      this.chatPiece.handleSend(req, res);
      return;
    }

    if (req.url === "/chat/abort" && req.method === "POST") {
      if (this.onAbort) this.onAbort();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/chat/clear-session" && req.method === "POST") {
      if (this.onClearSession) this.onClearSession();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/chat" && req.method === "POST") {
      this.chatPiece.handleChat(req, res);
      return;
    }

    if (req.url === "/chat-stream") {
      this.chatPiece.handleStream(req, res);
      return;
    }

    if (req.url === "/hud/hide" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { pieceId } = JSON.parse(body);
          // Skip ephemeral panels (actor chats) — they don't persist
          if (pieceId.startsWith("actor-chat-")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, skipped: true }));
            return;
          }
          const settings = loadSettings();
          if (!settings.pieces[pieceId]) settings.pieces[pieceId] = { enabled: true, visible: true };
          settings.pieces[pieceId].visible = false;
          saveSettings(settings);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    if (req.url === "/hud/layout" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const { pieceId, x, y, width, height } = JSON.parse(body);
          // Skip ephemeral panels (actor chats) — they don't persist
          if (pieceId.startsWith("actor-chat-")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, skipped: true }));
            return;
          }
          const settings = loadSettings();
          if (!settings.pieces[pieceId]) settings.pieces[pieceId] = { enabled: true, visible: true };
          settings.pieces[pieceId].config = {
            ...settings.pieces[pieceId].config,
            layout: { x, y, width, height },
          };
          saveSettings(settings);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    if (req.url === "/capabilities") {
      const data = this.getCapabilities ? this.getCapabilities() : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.url === "/hud") {
      const data = this.getHudState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.url === "/logs") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      for (const entry of getLogBuffer()) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      const unsub = onLogEntry((entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
      req.on("close", unsub);
      return;
    }

    // Plugin-registered routes (prefix match)
    for (const [key, handler] of this.pluginRoutes) {
      const spaceIdx = key.indexOf(" ");
      const method = key.slice(0, spaceIdx);
      const path = key.slice(spaceIdx + 1);
      if (req.method === method && req.url?.startsWith(path)) {
        handler(req, res);
        return;
      }
    }

    // Plugin renderer compilation endpoint
    // URL: /plugins/{name}/renderers/{file}.js
    if (req.url?.startsWith("/plugins/") && req.url?.endsWith(".js")) {
      const parts = req.url.split("/");
      // parts = ["", "plugins", name, "renderers", "file.js"]
      if (parts.length === 5 && parts[3] === "renderers") {
        const pluginName = parts[2];
        const fileName = parts[4].replace(".js", ".tsx");
        this.servePluginRenderer(pluginName, fileName, res);
        return;
      }
    }

    // Static files
    const filePath = req.url === "/" || req.url === "" ? join(UI_DIST, "index.html") : join(UI_DIST, req.url!);
    if (existsSync(filePath)) {
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    // SPA fallback
    const indexPath = join(UI_DIST, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(indexPath));
      return;
    }

    res.writeHead(404); res.end();
  }

  private async servePluginRenderer(pluginName: string, fileName: string, res: ServerResponse): Promise<void> {
    const settings = (await import("./core/settings.js")).load();
    const pluginPath = settings.plugins?.[pluginName]?.path;

    if (!pluginPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Plugin not found: ${pluginName}` }));
      return;
    }

    const filePath = join(pluginPath, "renderers", fileName);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Renderer not found: ${fileName}` }));
      return;
    }

    const cacheKey = `${pluginName}/${fileName}`;
    const stat = statSync(filePath);
    const cached = this.rendererCache.get(cacheKey);

    if (cached && cached.mtime === stat.mtimeMs) {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(cached.js);
      return;
    }

    try {
      const esbuild = await import("esbuild");
      // Externalize React — the app exposes it via window globals
      const result = await esbuild.build({
        entryPoints: [filePath],
        bundle: true,
        format: "esm",
        target: "esnext",
        jsx: "transform",
        jsxFactory: "__jarvis_jsx",
        jsxFragment: "__jarvis_Fragment",
        write: false,
        external: ["@jarvis/core"],
        banner: {
          js: `const { createElement: __jarvis_jsx, Fragment: __jarvis_Fragment, useEffect, useRef, useState, useCallback, useMemo } = window.__JARVIS_REACT;`,
        },
      });

      const js = result.outputFiles[0].text;
      this.rendererCache.set(cacheKey, { js, mtime: stat.mtimeMs });

      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(js);
    } catch (err) {
      log.error({ pluginName, fileName, err: String(err) }, "HttpServer: renderer compilation failed");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Compilation failed: ${err}` }));
    }
  }

  stop(): void { this.server.close(); }
}

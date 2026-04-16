// src/capabilities/loader.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { HudUpdateMessage } from "../core/types.js";
import type { CapabilityRegistry } from "./registry.js";
import { log } from "../logger/index.js";

const execFileAsync = promisify(execFile);

interface CapabilityConfig {
  name: string;
  description: string;
  type: "script" | "executable";
  command: string;
  args?: string[];
  stdin?: string;
  input_schema: Record<string, unknown>;
}

const CAPABILITIES_DIR = join(process.cwd(), "capabilities");

export class CapabilityLoaderPiece implements Piece {
  readonly id = "capability-loader";
  readonly name = "Capability Loader";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private loaded: string[] = [];

  systemContext(): string {
    return `## Capability Loader Piece
You have ${this.loaded.length} file-system capabilities loaded: ${this.loaded.join(', ')}.
These capabilities let you interact with the user's filesystem — read, write, edit files, search content, list directories, and run shell commands.
The user's home directory is ${process.env.HOME}. Current working directory is ${process.cwd()}.`;
  }

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.loadCapabilities();

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "indicator",
        name: this.name,
        status: "running",
        data: { capabilities: this.loaded },
        position: { x: 10, y: 70 },
        size: { width: 150, height: 40 },
      },
    });

    log.info({ count: this.loaded.length, capabilities: this.loaded }, "CapabilityLoader: loaded");
  }

  async stop(): Promise<void> {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
  }

  private loadCapabilities(): void {
    if (!existsSync(CAPABILITIES_DIR)) {
      log.info({ dir: CAPABILITIES_DIR }, "CapabilityLoader: capabilities directory not found, skipping");
      return;
    }

    const files = readdirSync(CAPABILITIES_DIR).filter(f => f.endsWith(".json"));

    for (const file of files) {
      try {
        const content = readFileSync(join(CAPABILITIES_DIR, file), "utf-8");
        const config: CapabilityConfig = JSON.parse(content);
        this.registerCapability(config);
        this.loaded.push(config.name);
      } catch (err) {
        log.error({ file, err }, "CapabilityLoader: failed to load capability");
      }
    }
  }

  private execWithStdin(command: string, args: string[], stdinData: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { timeout: 30000 });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          const err: any = new Error(`Process exited with code ${code}`);
          err.stderr = stderr;
          err.code = code;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });

      child.stdin.write(stdinData);
      child.stdin.end();
    });
  }

  private parseOutput(stdout: string, stderr: string): unknown {
    const output = stdout;
    if (output.startsWith("__TYPE__:image\n")) {
      const lines = output.split("\n").filter(l => l.trim());
      const mimeLine = lines.find(l => l.startsWith("__MIME__:"));
      const mime = mimeLine?.replace("__MIME__:", "") ?? "image/png";

      // Check if next line is a file path (starts with /)
      const dataLine = lines.find(l => !l.startsWith("__TYPE__:") && !l.startsWith("__MIME__:"));
      let base64Data: string;

      if (dataLine && dataLine.startsWith("/")) {
        // It's a file path — read and encode (readFileSync imported at top)
        try {
          const buf = readFileSync(dataLine.trim());
          base64Data = buf.toString("base64");
          // Detect mime from extension
          const ext = dataLine.trim().split(".").pop()?.toLowerCase();
          const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
          const detectedMime = mimeMap[ext ?? ""] ?? mime;
          return [
            { type: "image" as const, source: { type: "base64" as const, media_type: detectedMime, data: base64Data } },
          ];
        } catch (err: any) {
          return { error: `Failed to read image file: ${err.message}` };
        }
      }

      // Otherwise it's inline base64
      base64Data = lines.slice(lines.findIndex(l => l.startsWith("__MIME__:")) + 1).join("\n").trim();
      return [
        { type: "image" as const, source: { type: "base64" as const, media_type: mime, data: base64Data } },
      ];
    }

    if (output.startsWith("__TYPE__:error\n")) {
      return { error: output.split("\n").slice(1).join("\n").trim() };
    }

    const text = output.startsWith("__TYPE__:text\n")
      ? output.split("\n").slice(1).join("\n").trim()
      : output.trim();
    return { stdout: text, stderr: stderr.trim() || undefined };
  }

  private registerCapability(config: CapabilityConfig): void {
    this.registry.register({
      name: config.name,
      description: config.description,
      input_schema: config.input_schema,
      handler: async (input) => {
        // Expand ~ and substitute ${param} in args
        const expand = (s: string) => s.replace(/^~/, process.env.HOME ?? "~");
        const args = (config.args ?? []).map(arg =>
          expand(arg.replace(/\$\{(\w+)\}/g, (_, key) => expand(String(input[key] ?? ""))))
        );

        // Resolve stdin template if defined
        const stdinData = config.stdin
          ? config.stdin.replace(/\$\{(\w+)\}/g, (_, key) => String(input[key] ?? ""))
          : undefined;

        try {
          const { stdout, stderr } = stdinData !== undefined
            ? await this.execWithStdin(config.command, args, stdinData)
            : await execFileAsync(config.command, args, {
                timeout: 30000,
                maxBuffer: 1024 * 1024 * 10,
              });

          return this.parseOutput(stdout, stderr);
        } catch (err: any) {
          return {
            error: err.message,
            stderr: err.stderr?.trim(),
            exitCode: err.code,
          };
        }
      },
    });
  }
}

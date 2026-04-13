// src/core/cron-piece.ts
// Cron/Scheduling piece — schedule prompts to run on intervals or at specific times.
// Results are published via ai.stream to appear in chat.

import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { AIRequestMessage, HudUpdateMessage } from "./types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { log } from "../logger/index.js";

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  target: string;
  recurring: boolean;
  nextRun: number;
  interval?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
  createdAt: number;
  runs: number;
}

function parseCron(cron: string): { intervalMs?: number; nextMs?: number } {
  // Simple cron support:
  // "*/N * * * *" — every N minutes
  // "N * * * *" — at minute N of every hour
  // "once:Ns" — one-shot in N seconds
  // "once:Nm" — one-shot in N minutes

  if (cron.startsWith("once:")) {
    const val = cron.slice(5);
    const num = parseInt(val);
    if (val.endsWith("s")) return { nextMs: num * 1000 };
    if (val.endsWith("m")) return { nextMs: num * 60000 };
    if (val.endsWith("h")) return { nextMs: num * 3600000 };
    return { nextMs: num * 1000 };
  }

  const parts = cron.split(" ");
  if (parts.length >= 1) {
    const min = parts[0];
    if (min.startsWith("*/")) {
      const every = parseInt(min.slice(2));
      if (!isNaN(every) && every > 0) return { intervalMs: every * 60000 };
    }
  }

  return {};
}

export class CronPiece implements Piece {
  readonly id = "cron";
  readonly name = "Scheduler";

  private bus!: EventBus;
  private registry: CapabilityRegistry;
  private jobs = new Map<string, CronJob>();
  private counter = 0;

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;
  }

  systemContext(): string {
    if (this.jobs.size === 0) return "";
    const list = [...this.jobs.values()]
      .map(j => `${j.id}: "${j.prompt.slice(0, 50)}" (${j.recurring ? j.cron : 'one-shot'}, ${j.runs} runs)`)
      .join("\n");
    return `## Scheduler\nActive jobs:\n${list}\nTools: cron_create, cron_list, cron_delete`;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.registerTools();

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
        data: this.getData(),
        position: { x: 10, y: 160 },
        size: { width: 150, height: 40 },
      },
    } as any);

    log.info("CronPiece: started");
  }

  async stop(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.interval) clearInterval(job.interval);
      if (job.timeout) clearTimeout(job.timeout);
    }
    this.jobs.clear();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    } as any);
  }

  private executeJob(job: CronJob): void {
    job.runs++;
    log.info({ jobId: job.id, prompt: job.prompt.slice(0, 50), runs: job.runs }, "CronPiece: executing job");

    // Publish as ai.request — target determines who processes it
    this.bus.publish({
      channel: "ai.request",
      source: "cron",
      target: job.target,
      text: `[CRON job "${job.id}"] ${job.prompt}`,
    } as any);

    this.updateHud();

    // One-shot: remove after execution
    if (!job.recurring) {
      this.jobs.delete(job.id);
      this.updateHud();
    }
  }

  private scheduleJob(job: CronJob): void {
    const { intervalMs, nextMs } = parseCron(job.cron);

    if (job.recurring && intervalMs) {
      job.interval = setInterval(() => this.executeJob(job), intervalMs);
      job.nextRun = Date.now() + intervalMs;
    } else if (nextMs) {
      job.timeout = setTimeout(() => this.executeJob(job), nextMs);
      job.nextRun = Date.now() + nextMs;
    }
  }

  private registerTools(): void {
    this.registry.register({
      name: "cron_create",
      description: "Schedule a prompt to run on a timer. Use cron expressions like '*/5 * * * *' (every 5 min) or 'once:30s' (one-shot in 30 seconds), 'once:5m' (one-shot in 5 minutes). Use target to send to a specific actor (e.g. 'actor-alice').",
      input_schema: {
        type: "object",
        properties: {
          cron: { type: "string", description: "Schedule: '*/N * * * *' for every N minutes, 'once:Ns' or 'once:Nm' for one-shot" },
          prompt: { type: "string", description: "The prompt to execute at each trigger" },
          target: { type: "string", description: "Target session: 'main' (default, JARVIS processes) or 'actor-{name}' (actor processes directly)" },
          recurring: { type: "boolean", description: "true for recurring (default), false for one-shot" },
        },
        required: ["cron", "prompt"],
      },
      handler: async (input) => {
        const id = `job-${++this.counter}`;
        const cron = String(input.cron);
        const prompt = String(input.prompt);
        const target = input.target ? String(input.target) : "main";
        const recurring = input.recurring !== false;

        const { intervalMs, nextMs } = parseCron(cron);
        if (!intervalMs && !nextMs) {
          return { ok: false, error: `Invalid cron expression: ${cron}. Use '*/N * * * *' or 'once:Ns/Nm/Nh'` };
        }

        const job: CronJob = {
          id, cron, prompt, target, recurring,
          nextRun: 0, createdAt: Date.now(), runs: 0,
        };
        this.jobs.set(id, job);
        this.scheduleJob(job);
        this.updateHud();

        log.info({ id, cron, prompt: prompt.slice(0, 50), recurring }, "CronPiece: job created");
        return { ok: true, id, cron, recurring, nextRunIn: intervalMs ?? nextMs };
      },
    });

    this.registry.register({
      name: "cron_list",
      description: "List all scheduled cron jobs.",
      input_schema: { type: "object", properties: {} },
      handler: async () => ({
        jobs: [...this.jobs.values()].map(j => ({
          id: j.id,
          cron: j.cron,
          prompt: j.prompt.slice(0, 100),
          recurring: j.recurring,
          runs: j.runs,
          createdAt: new Date(j.createdAt).toISOString(),
        })),
      }),
    });

    this.registry.register({
      name: "cron_delete",
      description: "Delete a scheduled cron job by ID.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string", description: "Job ID (e.g. 'job-1')" } },
        required: ["id"],
      },
      handler: async (input) => {
        const id = String(input.id);
        const job = this.jobs.get(id);
        if (!job) return { ok: false, error: `Job not found: ${id}` };
        if (job.interval) clearInterval(job.interval);
        if (job.timeout) clearTimeout(job.timeout);
        this.jobs.delete(id);
        this.updateHud();
        return { ok: true };
      },
    });
  }

  private getData(): Record<string, unknown> {
    return {
      jobs: this.jobs.size,
      active: [...this.jobs.values()].filter(j => j.recurring).length,
    };
  }

  private updateHud(): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: this.jobs.size > 0 ? "running" : "idle",
    } as any);
  }
}

// src/core/cron-piece.ts
// Cron/Scheduling piece — schedule prompts to run on intervals or at specific times.
// Results are published via ai.stream to appear in chat.
//
// Persistence: jobs are stored in settings.user.json under cron.jobs.
// On boot, all persisted jobs are restored. lastRun is tracked per job.
// Smart scheduling: on restore, calculates time until next run (not from zero).

import type { EventBus } from "./bus.js";
import type { Piece } from "./piece.js";
import type { AIRequestMessage, HudUpdateMessage } from "./types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { PersistedCronJob } from "./settings.js";
import { load as loadSettings, save as saveSettings, invalidateCache } from "./settings.js";
import { graphRegistry } from "./graph-registry.js";
import { log } from "../logger/index.js";

// NOTE: PieceManager is responsible for registering this piece as a core graph node.

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
  lastRun?: number;
  runs: number;
  // source tracks where this job came from for persistence decisions
  source: "tool" | "settings";
}

// ─── Cron parsing ─────────────────────────────────────────────────────────────
// Supported formats:
//   "*/N * * * *"       — every N minutes
//   "N * * * *"         — at minute N of every hour
//   "once:Ns/Nm/Nh"     — one-shot in N seconds/minutes/hours
//   "0 H * * *"         — daily at hour H (standard cron, minute must be 0)
//   "M H * * *"         — daily at HH:MM
//   "M H * * DOW"       — weekly (day-of-week: 0=Sun, 1=Mon, ... 6=Sat, also 1-5=weekdays)
//   "HH:MM"             — shorthand for daily at HH:MM

interface ParsedCron {
  type: "interval" | "once" | "daily" | "weekly";
  intervalMs?: number;   // for interval type
  nextMs?: number;       // for once type
  hour?: number;         // for daily/weekly
  minute?: number;       // for daily/weekly
  dow?: number[];        // for weekly: array of days-of-week (0=Sun..6=Sat)
}

function parseDow(dowStr: string): number[] {
  // supports "1-5" ranges and comma-separated values like "1,3,5"
  if (dowStr === "*") return [0, 1, 2, 3, 4, 5, 6];
  const result: number[] = [];
  const parts = dowStr.split(",");
  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let d = start; d <= end; d++) result.push(d);
    } else {
      result.push(Number(part));
    }
  }
  return result;
}

export function parseCron(cron: string): ParsedCron | null {
  const s = cron.trim();

  // once:Ns / once:Nm / once:Nh
  if (s.startsWith("once:")) {
    const val = s.slice(5);
    const num = parseInt(val);
    if (isNaN(num)) return null;
    if (val.endsWith("s")) return { type: "once", nextMs: num * 1000 };
    if (val.endsWith("m")) return { type: "once", nextMs: num * 60_000 };
    if (val.endsWith("h")) return { type: "once", nextMs: num * 3_600_000 };
    return { type: "once", nextMs: num * 1000 };
  }

  // HH:MM shorthand — daily
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(":").map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return { type: "daily", hour: h, minute: m, dow: [0, 1, 2, 3, 4, 5, 6] };
    }
    return null;
  }

  // standard cron: "M H dow_or_star ..."
  const parts = s.split(" ");
  if (parts.length >= 2) {
    const minPart = parts[0];
    const hourPart = parts[1];
    const dowPart = parts[4] ?? "*";

    // */N * * * * — every N minutes
    if (minPart.startsWith("*/")) {
      const every = parseInt(minPart.slice(2));
      if (!isNaN(every) && every > 0) return { type: "interval", intervalMs: every * 60_000 };
    }

    // M H * * DOW — daily or weekly
    const min = parseInt(minPart);
    const hour = parseInt(hourPart);
    if (!isNaN(min) && !isNaN(hour) && min >= 0 && min < 60 && hour >= 0 && hour < 24) {
      const dow = parseDow(dowPart);
      const type = (dowPart === "*" || dow.length === 7) ? "daily" : "weekly";
      return { type, hour, minute: min, dow };
    }
  }

  return null;
}

// ─── Next-run calculation ──────────────────────────────────────────────────────

/**
 * Calculate ms until the next scheduled run.
 * For interval jobs: uses lastRun to compute remaining time.
 * For daily/weekly jobs: finds the next calendar slot after now (or lastRun).
 */
export function msUntilNextRun(parsed: ParsedCron, lastRun?: number): number {
  const now = Date.now();

  if (parsed.type === "once") {
    return parsed.nextMs ?? 0;
  }

  if (parsed.type === "interval") {
    const interval = parsed.intervalMs ?? 60_000;
    if (!lastRun) return interval;
    const elapsed = now - lastRun;
    const remaining = interval - (elapsed % interval);
    // If remaining is very small (< 1s), run immediately in 1s
    return remaining < 1000 ? 1000 : remaining;
  }

  // daily / weekly
  const hour = parsed.hour ?? 0;
  const minute = parsed.minute ?? 0;
  const dow = parsed.dow ?? [0, 1, 2, 3, 4, 5, 6];

  const candidate = new Date();
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute);

  // Find the next matching slot (today or future days)
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(candidate.getTime() + offset * 86_400_000);
    if (dow.includes(d.getDay()) && d.getTime() > now) {
      return d.getTime() - now;
    }
  }

  // Fallback: 24h
  return 86_400_000;
}

// ─── CronPiece ────────────────────────────────────────────────────────────────

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
      .map(j => {
        const lastRunStr = j.lastRun ? new Date(j.lastRun).toISOString() : "never";
        return `${j.id}: "${j.prompt.slice(0, 50)}" (${j.recurring ? j.cron : "one-shot"}, runs=${j.runs}, lastRun=${lastRunStr})`;
      })
      .join("\n");
    return `## Scheduler\nActive jobs:\n${list}\nTools: cron_create, cron_list, cron_delete`;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.registerTools();
    this.restoreJobs();

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

    graphRegistry.setChildren(this.id, () => [...this.jobs.values()].map(j => ({
      id: `cron-${j.id}`,
      label: j.id,
      status: j.recurring ? "running" : "waiting",
      meta: { prompt: j.prompt.slice(0, 40), runs: j.runs },
    })));

    log.info({ restoredJobs: this.jobs.size }, "CronPiece: started");
  }

  async stop(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.interval) clearInterval(job.interval);
      if (job.timeout) clearTimeout(job.timeout);
    }
    this.jobs.clear();
    graphRegistry.setChildren(this.id, undefined);
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    } as any);
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  private restoreJobs(): void {
    const settings = loadSettings();
    const persisted = settings.cron?.jobs ?? {};
    let restored = 0;

    for (const [id, p] of Object.entries(persisted)) {
      // Extract highest counter to avoid ID collisions
      const num = parseInt(id.replace("job-", ""));
      if (!isNaN(num) && num > this.counter) this.counter = num;

      const parsed = parseCron(p.cron);
      if (!parsed) {
        log.warn({ id, cron: p.cron }, "CronPiece: skipping persisted job with invalid cron");
        continue;
      }

      // One-shot jobs that already ran are not restored
      if (!p.recurring && p.lastRun) {
        log.debug({ id }, "CronPiece: skipping completed one-shot job");
        continue;
      }

      const job: CronJob = {
        id,
        cron: p.cron,
        prompt: p.prompt,
        target: p.target,
        recurring: p.recurring,
        nextRun: 0,
        createdAt: p.createdAt,
        lastRun: p.lastRun,
        runs: 0,
        source: "tool",
      };

      this.jobs.set(id, job);
      this.scheduleJob(job, parsed);
      restored++;
    }

    if (restored > 0) {
      log.info({ restored }, "CronPiece: restored persisted jobs");
    }
  }

  private persistJob(job: CronJob): void {
    // Only persist jobs created via tool (not transient/in-memory only)
    const settings = loadSettings();
    if (!settings.cron) settings.cron = { jobs: {} };

    const persisted: PersistedCronJob = {
      cron: job.cron,
      prompt: job.prompt,
      target: job.target,
      recurring: job.recurring,
      createdAt: job.createdAt,
      lastRun: job.lastRun,
    };
    settings.cron.jobs[job.id] = persisted;
    saveSettings(settings);
    invalidateCache();
  }

  private removePersistedJob(id: string): void {
    const settings = loadSettings();
    if (!settings.cron?.jobs) return;
    delete settings.cron.jobs[id];
    saveSettings(settings);
    invalidateCache();
  }

  private updateLastRun(job: CronJob): void {
    const settings = loadSettings();
    if (!settings.cron?.jobs?.[job.id]) return;
    settings.cron.jobs[job.id].lastRun = job.lastRun;
    saveSettings(settings);
    invalidateCache();
  }

  // ─── Scheduling ─────────────────────────────────────────────────────────────

  private executeJob(job: CronJob): void {
    job.runs++;
    job.lastRun = Date.now();
    log.info(
      { jobId: job.id, prompt: job.prompt.slice(0, 50), runs: job.runs, lastRun: new Date(job.lastRun).toISOString() },
      "CronPiece: executing job",
    );

    this.bus.publish({
      channel: "ai.request",
      source: "cron",
      target: job.target,
      text: `[CRON job "${job.id}"] ${job.prompt}`,
    } as any);

    // Persist lastRun immediately
    this.updateLastRun(job);
    this.updateHud();

    if (!job.recurring) {
      // One-shot: remove from memory but keep in settings with lastRun recorded
      if (job.interval) clearInterval(job.interval);
      if (job.timeout) clearTimeout(job.timeout);
      this.jobs.delete(job.id);
      this.updateHud();
    }
  }

  private scheduleJob(job: CronJob, parsed?: ParsedCron): void {
    const p = parsed ?? parseCron(job.cron);
    if (!p) return;

    if (p.type === "interval") {
      // Smart: account for time already elapsed since last run
      const firstDelay = msUntilNextRun(p, job.lastRun);
      job.nextRun = Date.now() + firstDelay;

      // Initial delayed run, then setInterval from there
      job.timeout = setTimeout(() => {
        this.executeJob(job);
        if (job.recurring && this.jobs.has(job.id)) {
          job.interval = setInterval(() => this.executeJob(job), p.intervalMs!);
          job.nextRun = Date.now() + p.intervalMs!;
        }
      }, firstDelay);

    } else if (p.type === "once") {
      const delay = p.nextMs ?? 0;
      job.nextRun = Date.now() + delay;
      job.timeout = setTimeout(() => this.executeJob(job), delay);

    } else {
      // daily / weekly — schedule next occurrence, then re-schedule after each run
      const scheduleNext = () => {
        const delay = msUntilNextRun(p, job.lastRun);
        job.nextRun = Date.now() + delay;
        job.timeout = setTimeout(() => {
          this.executeJob(job);
          if (job.recurring && this.jobs.has(job.id)) {
            scheduleNext();
          }
        }, delay);
      };
      scheduleNext();
    }
  }

  // ─── Tool registration ───────────────────────────────────────────────────────

  private registerTools(): void {
    this.registry.register({
      name: "cron_create",
      description: "Schedule a prompt to run on a timer. Use cron expressions like '*/5 * * * *' (every 5 min) or 'once:30s' (one-shot in 30 seconds), 'once:5m' (one-shot in 5 minutes). target is REQUIRED — must be an explicit session ID (e.g. 'main', 'actor-alice'). No implicit default to prevent cross-session leakage.",
      input_schema: {
        type: "object",
        properties: {
          cron: { type: "string", description: "Schedule: '*/N * * * *' for every N minutes, 'once:Ns' or 'once:Nm' for one-shot" },
          prompt: { type: "string", description: "The prompt to execute at each trigger" },
          target: { type: "string", description: "Target session ID (REQUIRED). Examples: 'main', 'actor-alice', 'grpc-xyz'. No default — must be explicit." },
          recurring: { type: "boolean", description: "true for recurring (default), false for one-shot" },
        },
        required: ["cron", "prompt", "target"],
      },
      handler: async (input) => {
        const cron = String(input.cron);
        const prompt = String(input.prompt);
        const target = typeof input.target === "string" ? input.target.trim() : "";
        const recurring = input.recurring !== false;

        if (!target) {
          return { ok: false, error: "target is required and must be a non-empty session ID (e.g. 'main', 'actor-alice'). No implicit default." };
        }

        const parsed = parseCron(cron);
        if (!parsed) {
          return { ok: false, error: `Invalid cron expression: ${cron}. Use '*/N * * * *', 'once:Ns/Nm/Nh', 'HH:MM', or '0 H * * *'` };
        }

        const id = `job-${++this.counter}`;

        const job: CronJob = {
          id, cron, prompt, target, recurring,
          nextRun: 0, createdAt: Date.now(), runs: 0, source: "tool",
        };
        this.jobs.set(id, job);
        this.scheduleJob(job, parsed);
        this.persistJob(job);
        this.updateHud();

        const msUntil = msUntilNextRun(parsed);
        log.info({ id, cron, prompt: prompt.slice(0, 50), recurring, msUntil }, "CronPiece: job created");
        return { ok: true, id, cron, recurring, nextRunIn: msUntil };
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
          lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
          nextRun: new Date(j.nextRun).toISOString(),
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
        this.removePersistedJob(id);
        this.updateHud();
        return { ok: true };
      },
    });
  }

  // ─── HUD ────────────────────────────────────────────────────────────────────

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

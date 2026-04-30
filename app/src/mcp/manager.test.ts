import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configsEqual, McpManager, type McpServerConfig } from "./manager.js";
import { CapabilityRegistry } from "../capabilities/registry.js";

describe("configsEqual", () => {
  it("treats identical configs as equal", () => {
    const a: McpServerConfig = { type: "stdio", command: "foo", args: ["a", "b"], env: {} };
    const b: McpServerConfig = { type: "stdio", command: "foo", args: ["a", "b"], env: {} };
    expect(configsEqual(a, b)).toBe(true);
  });

  it("ignores top-level key order", () => {
    const a: McpServerConfig = { type: "stdio", command: "foo", args: [] };
    const b: McpServerConfig = { args: [], command: "foo", type: "stdio" } as McpServerConfig;
    expect(configsEqual(a, b)).toBe(true);
  });

  it("ignores nested key order in env/headers", () => {
    const a: McpServerConfig = { type: "http", url: "x", headers: { A: "1", B: "2" } };
    const b: McpServerConfig = { type: "http", url: "x", headers: { B: "2", A: "1" } };
    expect(configsEqual(a, b)).toBe(true);
  });

  it("detects command change", () => {
    const a: McpServerConfig = { type: "stdio", command: "foo", args: [] };
    const b: McpServerConfig = { type: "stdio", command: "bar", args: [] };
    expect(configsEqual(a, b)).toBe(false);
  });

  it("detects args order change (args are meaningful-order)", () => {
    const a: McpServerConfig = { type: "stdio", command: "c", args: ["--foo", "--bar"] };
    const b: McpServerConfig = { type: "stdio", command: "c", args: ["--bar", "--foo"] };
    expect(configsEqual(a, b)).toBe(false);
  });

  it("detects env change", () => {
    const a: McpServerConfig = { type: "stdio", command: "c", args: [], env: { X: "1" } };
    const b: McpServerConfig = { type: "stdio", command: "c", args: [], env: { X: "2" } };
    expect(configsEqual(a, b)).toBe(false);
  });

  it("detects autoConnect flip", () => {
    const a: McpServerConfig = { type: "http", url: "x", autoConnect: false };
    const b: McpServerConfig = { type: "http", url: "x", autoConnect: true };
    expect(configsEqual(a, b)).toBe(false);
  });

  it("treats missing vs explicit undefined fields as equal", () => {
    const a: McpServerConfig = { type: "stdio", command: "c", args: [] };
    const b: McpServerConfig = { type: "stdio", command: "c", args: [], env: undefined };
    expect(configsEqual(a, b)).toBe(true);
  });
});

describe("McpManager.refreshConfig", () => {
  let tmpDir: string;
  let configPath: string;
  let registry: CapabilityRegistry;
  let manager: McpManager;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `jarvis-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "mcp.json");
    registry = new CapabilityRegistry();
    manager = new McpManager(registry, configPath);
    // Minimal fake start — populate servers without spawning transports
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        alpha: { type: "stdio", command: "echo", args: ["alpha"] },
      },
    }));
    // Manually invoke loadServers via start with a no-op bus
    await manager.start({
      publish: () => {},
      subscribe: () => () => {},
      unsubscribe: () => {},
    } as any);
  });

  afterEach(async () => {
    try { await manager.stop(); } catch { /* ignore */ }
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds new servers on refresh", async () => {
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        alpha: { type: "stdio", command: "echo", args: ["alpha"] },
        beta: { type: "stdio", command: "echo", args: ["beta"] },
      },
    }));
    const result = await manager.refreshConfig();
    expect(result).toMatch(/Added: beta/);
    expect((manager as any).servers.has("beta")).toBe(true);
  });

  it("removes servers no longer in config", async () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    const result = await manager.refreshConfig();
    expect(result).toMatch(/Removed: alpha/);
    expect((manager as any).servers.has("alpha")).toBe(false);
  });

  it("reports no changes when config is identical", async () => {
    const result = await manager.refreshConfig();
    expect(result).toMatch(/No changes/);
  });

  it("detects CHANGED config and resets server state", async () => {
    const server = (manager as any).servers.get("alpha");
    // Simulate connected state so we can assert it gets reset.
    server.status = "connected";
    server.toolNames = ["t1", "t2"];

    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        alpha: { type: "stdio", command: "echo", args: ["alpha-v2"] },
      },
    }));
    const result = await manager.refreshConfig();
    expect(result).toMatch(/Updated: alpha/);

    const updated = (manager as any).servers.get("alpha");
    expect(updated.config.args).toEqual(["alpha-v2"]);
    // Previously-connected → auto-reconnect kicks in. Either the reconnect is
    // still pending ("connecting"), or it already errored out ("error" — `echo`
    // exits immediately so the transport closes). What MUST NOT happen is the
    // server staying with the old config or old toolNames.
    expect(["disconnected", "connecting", "error"]).toContain(updated.status);
    expect(updated.toolNames).toEqual([]);
  });

  it("does NOT report Updated when only whitespace/key-order changes in the JSON", async () => {
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        alpha: { args: ["alpha"], command: "echo", type: "stdio" },
      },
    }, null, 4));
    const result = await manager.refreshConfig();
    expect(result).toMatch(/No changes/);
  });

  it("reports both Added and Removed in the same refresh", async () => {
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        gamma: { type: "stdio", command: "echo", args: ["gamma"] },
      },
    }));
    const result = await manager.refreshConfig();
    expect(result).toMatch(/Added: gamma/);
    expect(result).toMatch(/Removed: alpha/);
  });
});

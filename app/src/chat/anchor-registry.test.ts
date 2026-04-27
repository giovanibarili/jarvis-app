import { describe, it, expect, vi } from "vitest";
import { ChatAnchorRegistry } from "./anchor-registry.js";

describe("ChatAnchorRegistry — set / list / clear", () => {
  it("registers an anchor and lists it", () => {
    const r = new ChatAnchorRegistry();
    const handle = r.set({
      sessionId: "main",
      source: "test",
      renderer: { builtin: "choice-card" },
      data: { hello: "world" },
    });
    const list = r.list("main");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: handle.id,
      sessionId: "main",
      source: "test",
      data: { hello: "world" },
      version: 1,
      order: 0,
    });
    expect(handle.isAlive()).toBe(true);
  });

  it("uses provided id when given", () => {
    const r = new ChatAnchorRegistry();
    const handle = r.set({
      id: "fixed-id",
      sessionId: "main",
      source: "t",
      renderer: { builtin: "choice-card" },
      data: {},
    });
    expect(handle.id).toBe("fixed-id");
  });

  it("auto-generates unique ids per session", () => {
    const r = new ChatAnchorRegistry();
    const h1 = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    const h2 = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    expect(h1.id).not.toBe(h2.id);
  });

  it("throws on duplicate id within the same session", () => {
    const r = new ChatAnchorRegistry();
    r.set({ id: "x", sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    expect(() =>
      r.set({ id: "x", sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} }),
    ).toThrow(/already exists/);
  });

  it("isolates anchors by session", () => {
    const r = new ChatAnchorRegistry();
    r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    r.set({ sessionId: "actor-x", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    expect(r.list("main")).toHaveLength(1);
    expect(r.list("actor-x")).toHaveLength(1);
    expect(r.list("absent")).toHaveLength(0);
  });

  it("preserves insertion order across mixed updates", () => {
    const r = new ChatAnchorRegistry();
    const a = r.set({ sessionId: "s", source: "t", renderer: { builtin: "choice-card" }, data: { n: 1 } });
    const b = r.set({ sessionId: "s", source: "t", renderer: { builtin: "choice-card" }, data: { n: 2 } });
    const c = r.set({ sessionId: "s", source: "t", renderer: { builtin: "choice-card" }, data: { n: 3 } });
    a.update({ n: 10 });
    expect(r.list("s").map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it("clear() removes the anchor and bumps version", () => {
    const r = new ChatAnchorRegistry();
    const h = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    const v0 = r.version("main");
    h.clear();
    expect(r.list("main")).toHaveLength(0);
    expect(r.version("main")).toBeGreaterThan(v0);
    expect(h.isAlive()).toBe(false);
  });

  it("clear() is idempotent", () => {
    const r = new ChatAnchorRegistry();
    const h = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    h.clear();
    h.clear();
    h.clear();
    expect(r.list("main")).toHaveLength(0);
  });

  it("clearSession() drops all anchors and handlers in that session", () => {
    const r = new ChatAnchorRegistry();
    const onAction = vi.fn();
    r.set({ id: "a", sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {}, onAction });
    r.set({ id: "b", sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {}, onAction });
    r.set({ id: "c", sessionId: "actor", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    r.clearSession("main");
    expect(r.list("main")).toHaveLength(0);
    expect(r.list("actor")).toHaveLength(1);
  });
});

describe("ChatAnchorRegistry — update / setRenderer", () => {
  it("update() shallow-merges data and bumps versions", () => {
    const r = new ChatAnchorRegistry();
    const h = r.set({
      sessionId: "main",
      source: "t",
      renderer: { builtin: "choice-card" },
      data: { a: 1, b: 2 },
    });
    const beforeVersion = r.list("main")[0].version;
    h.update({ b: 99, c: 3 });
    const after = r.list("main")[0];
    expect(after.data).toEqual({ a: 1, b: 99, c: 3 });
    expect(after.version).toBeGreaterThan(beforeVersion);
  });

  it("update() is no-op after clear", () => {
    const r = new ChatAnchorRegistry();
    const h = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: { a: 1 } });
    h.clear();
    h.update({ a: 2 });
    expect(r.list("main")).toHaveLength(0);
  });

  it("setRenderer() swaps renderer", () => {
    const r = new ChatAnchorRegistry();
    const h = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    h.setRenderer({ plugin: "my-plugin", file: "MyAnchor" });
    const after = r.list("main")[0];
    expect(after.renderer).toEqual({ plugin: "my-plugin", file: "MyAnchor" });
  });
});

describe("ChatAnchorRegistry — long-poll waitForChange", () => {
  it("resolves immediately if version is already ahead", async () => {
    const r = new ChatAnchorRegistry();
    r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    const v = await r.waitForChange("main", 0, 5000);
    expect(v).toBeGreaterThan(0);
  });

  it("resolves on next mutation", async () => {
    const r = new ChatAnchorRegistry();
    const v0 = r.version("main");
    const promise = r.waitForChange("main", v0, 5000);
    // mutate after a tick
    setTimeout(() => {
      r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    }, 5);
    const v = await promise;
    expect(v).toBeGreaterThan(v0);
  });

  it("resolves on timeout if no mutation happens", async () => {
    const r = new ChatAnchorRegistry();
    const v0 = r.version("main");
    const t0 = Date.now();
    const v = await r.waitForChange("main", v0, 30);
    const dt = Date.now() - t0;
    expect(v).toBe(v0);
    expect(dt).toBeGreaterThanOrEqual(20);
  });

  it("multiple waiters all flush on a single mutation", async () => {
    const r = new ChatAnchorRegistry();
    const v0 = r.version("main");
    const a = r.waitForChange("main", v0, 5000);
    const b = r.waitForChange("main", v0, 5000);
    const c = r.waitForChange("main", v0, 5000);
    setTimeout(() => {
      r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    }, 5);
    const [va, vb, vc] = await Promise.all([a, b, c]);
    expect(va).toBe(vb);
    expect(vb).toBe(vc);
    expect(va).toBeGreaterThan(v0);
  });

  it("clearSession() flushes pending waiters", async () => {
    const r = new ChatAnchorRegistry();
    r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {} });
    const v0 = r.version("main");
    const promise = r.waitForChange("main", v0, 5000);
    setTimeout(() => r.clearSession("main"), 5);
    const v = await promise;
    expect(v).toBeGreaterThan(v0);
  });
});

describe("ChatAnchorRegistry — invokeAction", () => {
  it("calls the registered handler with payload", async () => {
    const r = new ChatAnchorRegistry();
    const onAction = vi.fn();
    const h = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {}, onAction });
    const ok = await r.invokeAction("main", h.id, { hello: "world" });
    expect(ok).toBe(true);
    expect(onAction).toHaveBeenCalledWith({ hello: "world" });
  });

  it("returns false when no anchor exists", async () => {
    const r = new ChatAnchorRegistry();
    const ok = await r.invokeAction("main", "nope", null);
    expect(ok).toBe(false);
  });

  it("returns false after the anchor is cleared", async () => {
    const r = new ChatAnchorRegistry();
    const onAction = vi.fn();
    const h = r.set({ sessionId: "main", source: "t", renderer: { builtin: "choice-card" }, data: {}, onAction });
    h.clear();
    const ok = await r.invokeAction("main", h.id, {});
    expect(ok).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("propagates handler errors to caller", async () => {
    const r = new ChatAnchorRegistry();
    const h = r.set({
      sessionId: "main",
      source: "t",
      renderer: { builtin: "choice-card" },
      data: {},
      onAction: () => { throw new Error("boom"); },
    });
    await expect(r.invokeAction("main", h.id, null)).rejects.toThrow("boom");
  });

  it("supports async handlers", async () => {
    const r = new ChatAnchorRegistry();
    let resolved = false;
    const h = r.set({
      sessionId: "main",
      source: "t",
      renderer: { builtin: "choice-card" },
      data: {},
      onAction: async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
      },
    });
    await r.invokeAction("main", h.id, null);
    expect(resolved).toBe(true);
  });
});

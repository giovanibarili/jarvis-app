import { describe, it, expect, vi } from "vitest";
import { ChatPiece } from "./chat-piece.js";
import type { EventBus } from "../core/bus.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Tests for ChatPiece's session-agnostic routing in handleSend().
 *
 * Contract:
 *   - ChatPiece is plugin-agnostic. It NEVER mirrors type:"user" itself.
 *   - The session OWNER (JarvisCore for main/grpc-*, or any plugin owning
 *     custom sessionIds like actor-*) is responsible for emitting
 *     `prompt_dispatched` (timeline) when the prompt actually goes to the
 *     model and `pending_queue` (queue cards) while it waits.
 *   - ChatPiece only publishes `ai.request` on the bus and lets the owner
 *     decide what to broadcast.
 */

function makeBus(): { bus: EventBus; published: any[] } {
  const published: any[] = [];
  const bus = {
    publish: (msg: any) => { published.push(msg); },
    subscribe: () => () => {},
  } as unknown as EventBus;
  return { bus, published };
}

function makeReqRes(body: any): { req: IncomingMessage; res: ServerResponse; sent: any } {
  const sent: any = { headers: null, body: null };
  const req = {
    on: vi.fn((event: string, cb: any) => {
      if (event === "data") cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
    }),
  } as any;
  const res = {
    writeHead: (code: number, headers: any) => { sent.statusCode = code; sent.headers = headers; },
    end: (b: any) => { sent.body = b; },
  } as any;
  return { req, res, sent };
}

describe("ChatPiece.handleSend — session-agnostic routing", () => {
  it("does NOT broadcast type:'user' for any session — owner emits prompt_dispatched", async () => {
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res, sent } = makeReqRes({ sessionId: "main", prompt: "hello" });
    await piece.handleSend(req, res);

    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq).toBeDefined();
    expect(aiReq.text).toBe("hello");
    expect(aiReq.target).toBe("main");

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
    expect(sent.statusCode).toBe(200);
  });

  it("does NOT broadcast type:'user' for plugin-owned sessions either (actor-*)", async () => {
    // Same contract as core-owned sessions: the plugin owner (actor-runner)
    // is responsible for emitting prompt_dispatched. ChatPiece stays neutral.
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res, sent } = makeReqRes({ sessionId: "actor-jarvis-imp", prompt: "fix the bug" });
    await piece.handleSend(req, res);

    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq.target).toBe("actor-jarvis-imp");
    expect(aiReq.text).toBe("fix the bug");

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
    expect(sent.statusCode).toBe(200);
  });

  it("setOwnedSessionMatcher is a deprecated no-op (kept for backward compat)", async () => {
    const { bus } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    // Setting the matcher must not throw and must not change behavior.
    piece.setOwnedSessionMatcher((sid) => sid === "main");

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");
    const { req, res } = makeReqRes({ sessionId: "actor-x", prompt: "hi" });
    await piece.handleSend(req, res);

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
  });
});

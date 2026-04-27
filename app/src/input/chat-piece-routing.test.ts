import { describe, it, expect, vi } from "vitest";
import { ChatPiece } from "./chat-piece.js";
import type { EventBus } from "../core/bus.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Tests for ChatPiece's session-aware mirroring decision in handleSend().
 *
 * Behavior under test:
 *   - Sessions OWNED by JarvisCore (returns true from matcher) must NOT be
 *     mirrored as type:"user" SSE — JarvisCore will emit prompt_dispatched
 *     and that becomes the timeline entry.
 *   - Sessions NOT owned by JarvisCore (e.g. actor-* handled by plugin)
 *     MUST be mirrored as type:"user" SSE so the panel shows what the user
 *     typed. No core piece will emit prompt_dispatched for them.
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

describe("ChatPiece.handleSend — owned vs plugin sessions", () => {
  it("does NOT mirror type:'user' for owned sessions (main, grpc-*)", async () => {
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;
    piece.setOwnedSessionMatcher((sid) => sid === "main" || sid.startsWith("grpc-"));

    // Spy on the private broadcast — that's what type:"user" goes through.
    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res, sent } = makeReqRes({ sessionId: "main", prompt: "hello" });
    await piece.handleSend(req, res);

    // ai.request must always be published for the AI to react
    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq).toBeDefined();
    expect(aiReq.text).toBe("hello");
    expect(aiReq.target).toBe("main");

    // type:"user" must NOT be broadcast — JarvisCore will mirror via prompt_dispatched
    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
    expect(sent.statusCode).toBe(200);
  });

  it("mirrors type:'user' immediately for plugin-owned sessions (actor-*)", async () => {
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;
    piece.setOwnedSessionMatcher((sid) => sid === "main" || sid.startsWith("grpc-"));

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res, sent } = makeReqRes({ sessionId: "actor-jarvis-imp", prompt: "fix the bug" });
    await piece.handleSend(req, res);

    // ai.request still published — actor-runner subscribes to it
    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq.target).toBe("actor-jarvis-imp");

    // type:"user" IS broadcast immediately so the actor's chat panel shows it
    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(1);
    expect(userBroadcasts[0][1]).toMatchObject({
      type: "user",
      text: "fix the bug",
      session: "actor-jarvis-imp",
      source: "chat",
    });
    expect(sent.statusCode).toBe(200);
  });

  it("mirrors type:'user' for any session when matcher is unset (safe default)", async () => {
    // If wiring is broken or in tests where matcher isn't set, the safe
    // behavior is to mirror — better to show duplicate user msg once than
    // to lose the user's input entirely.
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;
    // intentionally no setOwnedSessionMatcher

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res } = makeReqRes({ sessionId: "main", prompt: "hi" });
    await piece.handleSend(req, res);

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(1);
    expect(published.find((m: any) => m.channel === "ai.request")).toBeDefined();
  });
});

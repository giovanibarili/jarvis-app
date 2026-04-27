import { describe, it, expect, vi } from "vitest";
import { ChatPiece } from "./chat-piece.js";
import type { EventBus } from "../core/bus.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * ChatPiece is a pure renderer of `ai.stream` flow events.
 *
 * Contract:
 *   - On POST /chat/send it MUST publish exactly one `ai.request` and
 *     MUST NOT broadcast `type:"user"` directly. The owner of the
 *     target session decides whether to dispatch (→ `prompt_dispatched`)
 *     or enqueue (→ `pending_queue`); ChatPiece forwards either as SSE.
 *   - The decision is per-flow, never per-status. ChatPiece never reads
 *     SessionManager state to infer where the message goes.
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

describe("ChatPiece.handleSend — pure flow renderer", () => {
  it("never broadcasts type:'user' for a normal prompt — owner is responsible", async () => {
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res, sent } = makeReqRes({ sessionId: "main", prompt: "hello" });
    await piece.handleSend(req, res);

    // Always publishes ai.request
    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq).toBeDefined();
    expect(aiReq.text).toBe("hello");
    expect(aiReq.target).toBe("main");

    // Never broadcasts type:"user" — that is the session owner's job
    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
    expect(sent.statusCode).toBe(200);
  });

  it("does NOT special-case actor-* sessions either — same flow rules apply", async () => {
    // Regression for the gap fixed by reverting #37: ChatPiece must NOT
    // know about actor-* or any specific naming convention. The owner
    // (actor-runner) emits prompt_dispatched / pending_queue itself.
    const { bus, published } = makeBus();
    const piece = new ChatPiece();
    (piece as any).bus = bus;

    const broadcastSpy = vi.spyOn(piece as any, "broadcast");

    const { req, res } = makeReqRes({ sessionId: "actor-jarvis-imp", prompt: "fix the bug" });
    await piece.handleSend(req, res);

    const aiReq = published.find((m: any) => m.channel === "ai.request");
    expect(aiReq.target).toBe("actor-jarvis-imp");

    const userBroadcasts = broadcastSpy.mock.calls.filter(
      ([_sid, evt]: any[]) => evt?.type === "user"
    );
    expect(userBroadcasts).toHaveLength(0);
  });
});

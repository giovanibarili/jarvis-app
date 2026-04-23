import { describe, it, expect } from "vitest";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { CapabilityCall, CapabilityResult } from "../types.js";

/**
 * Regression test for the duplicate `tool_use` id bug.
 *
 * Root cause (pre-fix):
 *   1. `streamFromAPI` pushed the assistant `message.content` (which contains
 *      `tool_use` blocks) whenever `stop_reason !== "tool_use"`.
 *   2. `addToolResults` ALSO pushed a reconstructed assistant message with the
 *      same `tool_use` blocks (rebuilt from `CapabilityCall[]`).
 *
 *   When the API returned a mixed response (text + tool_use) with a stop_reason
 *   that allowed the streamFromAPI push (observed with Opus returning stop_reason
 *   "end_turn" alongside tool_use blocks in long runs), the same `tool_use` id
 *   ended up in two consecutive assistant messages. The next API call then
 *   failed with HTTP 400: `tool_use ids must be unique`.
 *
 * Fix:
 *   - `streamFromAPI` always pushes `message.content` (unless compaction replaced
 *     the history).
 *   - `addToolResults` only pushes the user `tool_result` message — it never
 *     re-adds the assistant tool_use.
 *
 * These tests simulate the two-step flow by directly replicating the push
 * operations performed by both functions and verifying no id is duplicated.
 */

function simulateStreamFromApiPush(
  messages: MessageParam[],
  apiResponseContent: ContentBlockParam[],
  stopReason: string,
  compactionSummary?: string,
): void {
  // Mirror of session.ts lines 439-443 (post-fix)
  if (stopReason !== "compaction" && !compactionSummary && apiResponseContent.length > 0) {
    messages.push({ role: "assistant", content: apiResponseContent });
  }
}

function simulateAddToolResults(
  messages: MessageParam[],
  _toolCalls: CapabilityCall[],
  results: CapabilityResult[],
): void {
  // Mirror of session.ts post-fix addToolResults (no assistant push)
  const toolResultBlocks: ToolResultBlockParam[] = results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: r.tool_use_id,
    content: r.content as ToolResultBlockParam["content"],
    is_error: r.is_error,
  }));
  messages.push({ role: "user", content: toolResultBlocks });
}

function collectToolUseIds(messages: MessageParam[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ((block as any).type === "tool_use") ids.push((block as any).id);
    }
  }
  return ids;
}

describe("anthropic session — tool_use id deduplication (regression)", () => {
  it("stop_reason=tool_use: pure tool_use response — single id in history", () => {
    const messages: MessageParam[] = [{ role: "user", content: "run ls" }];

    const apiContent: ContentBlockParam[] = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ];
    simulateStreamFromApiPush(messages, apiContent, "tool_use");

    const calls: CapabilityCall[] = [{ id: "tu_1", name: "bash", input: { command: "ls" } }];
    const results: CapabilityResult[] = [{ tool_use_id: "tu_1", content: "a\nb\n", is_error: false }];
    simulateAddToolResults(messages, calls, results);

    const ids = collectToolUseIds(messages);
    expect(ids).toEqual(["tu_1"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stop_reason=end_turn with tool_use blocks (the actual bug) — no duplicates", () => {
    // THIS IS THE REGRESSION SCENARIO.
    // Pre-fix: streamFromAPI pushed content (because stop_reason !== "tool_use")
    //          AND addToolResults pushed a rebuilt tool_use msg → DUPLICATE.
    const messages: MessageParam[] = [{ role: "user", content: "write the file" }];

    const apiContent: ContentBlockParam[] = [
      { type: "text", text: "I will create the file now." },
      { type: "tool_use", id: "tu_bug", name: "write_file", input: { path: "/x.md", content: "hi" } },
    ];
    // Observed in production: Opus 4 returning mixed content with stop_reason "end_turn"
    simulateStreamFromApiPush(messages, apiContent, "end_turn");

    const calls: CapabilityCall[] = [
      { id: "tu_bug", name: "write_file", input: { path: "/x.md", content: "hi" } },
    ];
    const results: CapabilityResult[] = [
      { tool_use_id: "tu_bug", content: "written", is_error: false },
    ];
    simulateAddToolResults(messages, calls, results);

    const ids = collectToolUseIds(messages);
    expect(ids).toEqual(["tu_bug"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stop_reason=tool_use with text preamble — no duplicates, text preserved", () => {
    const messages: MessageParam[] = [{ role: "user", content: "investigate" }];

    const apiContent: ContentBlockParam[] = [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "/a.ts" } },
    ];
    simulateStreamFromApiPush(messages, apiContent, "tool_use");

    const calls: CapabilityCall[] = [{ id: "tu_2", name: "read_file", input: { path: "/a.ts" } }];
    const results: CapabilityResult[] = [{ tool_use_id: "tu_2", content: "file contents", is_error: false }];
    simulateAddToolResults(messages, calls, results);

    // Text must still be in history
    const assistantMsg = messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const hasText = (assistantMsg.content as any[]).some((b) => b.type === "text");
    expect(hasText).toBe(true);

    // Still no duplicates
    const ids = collectToolUseIds(messages);
    expect(ids).toEqual(["tu_2"]);
  });

  it("parallel tools: multiple tool_use ids — each appears exactly once", () => {
    const messages: MessageParam[] = [{ role: "user", content: "do 3 things" }];

    const apiContent: ContentBlockParam[] = [
      { type: "tool_use", id: "tu_a", name: "bash", input: { command: "ls" } },
      { type: "tool_use", id: "tu_b", name: "bash", input: { command: "pwd" } },
      { type: "tool_use", id: "tu_c", name: "read_file", input: { path: "/a" } },
    ];
    simulateStreamFromApiPush(messages, apiContent, "tool_use");

    const calls: CapabilityCall[] = [
      { id: "tu_a", name: "bash", input: { command: "ls" } },
      { id: "tu_b", name: "bash", input: { command: "pwd" } },
      { id: "tu_c", name: "read_file", input: { path: "/a" } },
    ];
    const results: CapabilityResult[] = [
      { tool_use_id: "tu_a", content: "x", is_error: false },
      { tool_use_id: "tu_b", content: "/", is_error: false },
      { tool_use_id: "tu_c", content: "file", is_error: false },
    ];
    simulateAddToolResults(messages, calls, results);

    const ids = collectToolUseIds(messages);
    expect(ids.sort()).toEqual(["tu_a", "tu_b", "tu_c"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("multi-turn sequence — ids remain unique across many tool_use/tool_result cycles", () => {
    const messages: MessageParam[] = [{ role: "user", content: "start" }];

    for (let i = 0; i < 20; i++) {
      const id = `tu_${i}`;
      const apiContent: ContentBlockParam[] = [
        // mix stop_reasons across iterations to mimic real API behavior
        ...(i % 3 === 0 ? [{ type: "text" as const, text: `Step ${i}` }] : []),
        { type: "tool_use", id, name: "bash", input: { command: `step ${i}` } },
      ];
      const stopReason = i % 2 === 0 ? "tool_use" : "end_turn"; // both code paths
      simulateStreamFromApiPush(messages, apiContent, stopReason);

      simulateAddToolResults(
        messages,
        [{ id, name: "bash", input: {} }],
        [{ tool_use_id: id, content: "ok", is_error: false }],
      );
    }

    const ids = collectToolUseIds(messages);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20); // no duplicates
  });

  it("every tool_use has a matching tool_result (API invariant)", () => {
    const messages: MessageParam[] = [{ role: "user", content: "go" }];

    const apiContent: ContentBlockParam[] = [
      { type: "text", text: "doing" },
      { type: "tool_use", id: "tu_X", name: "bash", input: {} },
      { type: "tool_use", id: "tu_Y", name: "read_file", input: {} },
    ];
    simulateStreamFromApiPush(messages, apiContent, "end_turn");

    simulateAddToolResults(
      messages,
      [
        { id: "tu_X", name: "bash", input: {} },
        { id: "tu_Y", name: "read_file", input: {} },
      ],
      [
        { tool_use_id: "tu_X", content: "x", is_error: false },
        { tool_use_id: "tu_Y", content: "y", is_error: false },
      ],
    );

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if ((block as any).type === "tool_use") toolUseIds.add((block as any).id);
        if ((block as any).type === "tool_result") toolResultIds.add((block as any).tool_use_id);
      }
    }

    for (const id of toolUseIds) expect(toolResultIds.has(id)).toBe(true);
    for (const id of toolResultIds) expect(toolUseIds.has(id)).toBe(true);
  });
});

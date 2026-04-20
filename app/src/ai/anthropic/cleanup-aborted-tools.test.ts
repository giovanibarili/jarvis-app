import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { CapabilityCall } from "../types.js";
import { cleanupAbortedToolMessages } from "./cleanup-aborted-tools.js";

const pendingCalls: CapabilityCall[] = [
  { id: "t1", name: "bash", input: { command: "ls" } },
];

const parallelCalls: CapabilityCall[] = [
  { id: "t1", name: "bash", input: { command: "ls" } },
  { id: "t2", name: "read_file", input: { path: "/a" } },
];

describe("cleanupAbortedToolMessages", () => {
  it("scenario: tool_use NOT in history (normal abort) — appends both tool_use and tool_result", () => {
    // streamFromAPI skips pushing the assistant message on stop_reason === "tool_use",
    // so messages only has the user prompt. Cleanup must add both halves.
    const messages: MessageParam[] = [
      { role: "user", content: "run something" },
    ];
    const result = cleanupAbortedToolMessages(messages, pendingCalls);

    // Should have: original user msg + assistant tool_use + user tool_result
    expect(result).toHaveLength(3);

    // Assistant message with tool_use block
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
    });

    // User message with tool_result block (is_error: true, matching ID)
    expect(result[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "[Tool execution was aborted by user]",
          is_error: true,
        },
      ],
    });
  });

  it("scenario: tool_use already in history but no tool_result — adds only tool_result", () => {
    // Edge case: if the assistant message with tool_use somehow got into history
    // (e.g., compaction pushed it) but addToolResults never ran.
    const messages: MessageParam[] = [
      { role: "user", content: "run something" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      },
    ];
    const result = cleanupAbortedToolMessages(messages, pendingCalls);

    // Should have: original user msg + existing assistant tool_use + new user tool_result
    expect(result).toHaveLength(3);

    // Original assistant message preserved
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
    });

    // New tool_result with matching ID
    expect(result[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "[Tool execution was aborted by user]",
          is_error: true,
        },
      ],
    });
  });

  it("scenario: tool_use AND tool_result already in history — no changes", () => {
    // addToolResults already ran (race condition or double call).
    // Cleanup should not duplicate anything.
    const messages: MessageParam[] = [
      { role: "user", content: "run something" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
      },
    ];
    const result = cleanupAbortedToolMessages(messages, pendingCalls);

    // Nothing should be added — already complete
    expect(result).toHaveLength(3);
    expect(result).toEqual(messages);
  });

  it("parallel tools: appends all tool_use and tool_result blocks", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do two things" },
    ];
    const result = cleanupAbortedToolMessages(messages, parallelCalls);

    // Should have: user msg + assistant (2 tool_use blocks) + user (2 tool_result blocks)
    expect(result).toHaveLength(3);

    // Assistant message with both tool_use blocks
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        { type: "tool_use", id: "t2", name: "read_file", input: { path: "/a" } },
      ],
    });

    // User message with both tool_result blocks (matching IDs)
    expect(result[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "[Tool execution was aborted by user]",
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: "[Tool execution was aborted by user]",
          is_error: true,
        },
      ],
    });
  });

  it("partial parallel: one tool_use in history, other missing — adds only what's needed", () => {
    // t1 somehow made it into history, t2 did not
    const messages: MessageParam[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      },
    ];
    const result = cleanupAbortedToolMessages(messages, parallelCalls);

    // Original 2 + new assistant (t2 tool_use) + new user (t1 + t2 tool_results)
    expect(result).toHaveLength(4);

    // t2 tool_use added as a new assistant message
    expect(result[2]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "t2", name: "read_file", input: { path: "/a" } },
      ],
    });

    // Both tool_results added (t1 was missing a result, t2 was missing a result)
    expect(result[3]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "[Tool execution was aborted by user]",
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: "[Tool execution was aborted by user]",
          is_error: true,
        },
      ],
    });
  });

  it("empty pending calls — returns messages unchanged", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
    ];
    const result = cleanupAbortedToolMessages(messages, []);
    expect(result).toEqual(messages);
  });

  it("does not mutate the original array", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "run something" },
    ];
    const original = JSON.parse(JSON.stringify(messages));
    cleanupAbortedToolMessages(messages, pendingCalls);
    expect(messages).toEqual(original);
  });

  it("key invariant: every tool_use ID has a matching tool_result ID", () => {
    // Test with a messy history that has some orphan tool_use IDs from prior turns
    const messages: MessageParam[] = [
      { role: "user", content: "first request" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "old1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "old1", content: "done" }],
      },
      { role: "assistant", content: "ok, what next?" },
      { role: "user", content: "run something else" },
    ];
    const result = cleanupAbortedToolMessages(messages, pendingCalls);

    // Collect all tool_use IDs and tool_result IDs
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of result) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if ((block as any).type === "tool_use") toolUseIds.add((block as any).id);
        if ((block as any).type === "tool_result") toolResultIds.add((block as any).tool_use_id);
      }
    }

    // Every tool_use must have a matching tool_result
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});

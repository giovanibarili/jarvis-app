import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { sanitizeMessages } from "./sanitize-messages.js";

describe("sanitizeMessages", () => {
  it("returns clean history unchanged", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toEqual(messages);
    expect(result).not.toBe(messages);
  });

  it("returns valid tool_use + tool_result pairs unchanged", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "run bash" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file.txt" }],
      },
      { role: "assistant", content: "I see file.txt" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toEqual(messages);
  });

  it("replaces orphan tool_result (no preceding tool_use) with text summary", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "sure, let me check" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan_1", content: "some output" }],
      },
      { role: "user", content: "new message" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[2]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("replaces orphan tool_use + tool_result pair with text summaries", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_A", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_WRONG", content: "output" }],
      },
      { role: "user", content: "next prompt" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash]",
    });
    expect(result[2]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("handles multiple orphans in the same history", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      { role: "assistant", content: "got it" },
      { role: "user", content: "second" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "bash", input: { command: "pwd" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t_orphan", content: "out" }],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[2]).toEqual(messages[2]);
    expect(result[3]).toEqual(messages[3]);
    expect(result[4]).toEqual(messages[4]);
    expect(result[5]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash]",
    });
    expect(result[6]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("handles tool_result with multiple tool_use_ids (parallel tools)", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "files" },
          { type: "tool_result", tool_use_id: "t2", content: "content" },
        ],
      },
      { role: "assistant", content: "done" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toEqual(messages);
  });

  it("detects partial match in parallel tools as orphan", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "files" },
          { type: "tool_result", tool_use_id: "t_WRONG", content: "content" },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result[1]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash, read_file]",
    });
    expect(result[2]).toEqual({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  });

  it("does not mutate the original array", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t_orphan", content: "x" }],
      },
    ];
    const original = JSON.parse(JSON.stringify(messages));
    sanitizeMessages(messages);
    expect(messages).toEqual(original);
  });
});

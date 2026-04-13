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
  it("scenario A: addToolResults already ran — replaces tool_use + tool_result pair", () => {
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
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash]",
    });
    expect(result[2]).toEqual({
      role: "user",
      content: "[bash was interrupted]",
    });
  });

  it("scenario B: addToolResults has not run — appends interrupt context", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "run something" },
    ];
    const result = cleanupAbortedToolMessages(messages, pendingCalls);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash]",
    });
  });

  it("scenario A with parallel tools — includes all tool names", () => {
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
    ];
    const result = cleanupAbortedToolMessages(messages, parallelCalls);
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({
      role: "assistant",
      content: "[Interrupted: was about to execute bash, read_file]",
    });
    expect(result[2]).toEqual({
      role: "user",
      content: "[bash, read_file was interrupted]",
    });
  });

  it("does not mutate the original array", () => {
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
    const original = JSON.parse(JSON.stringify(messages));
    cleanupAbortedToolMessages(messages, pendingCalls);
    expect(messages).toEqual(original);
  });
});

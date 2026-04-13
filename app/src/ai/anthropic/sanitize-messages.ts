import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { log } from "../../logger/index.js";

export function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (!hasToolResultBlocks(msg)) {
      result.push(msg);
      continue;
    }

    const toolResultIds = getToolResultIds(msg);
    const prev = result[result.length - 1];
    const prevToolUseIds = prev ? getToolUseIds(prev) : new Set<string>();
    const allMatched = toolResultIds.every((id) => prevToolUseIds.has(id));

    if (allMatched) {
      result.push(msg);
      continue;
    }

    const toolNames = prev ? getToolUseNames(prev) : [];
    const namesStr = toolNames.length > 0 ? toolNames.join(", ") : "unknown";

    log.warn(
      { index: i, orphanIds: toolResultIds.filter((id) => !prevToolUseIds.has(id)), toolNames },
      "sanitizeMessages: replacing orphan tool pair with text summary",
    );

    if (prev && hasToolUseBlocks(prev)) {
      result[result.length - 1] = {
        role: "assistant",
        content: `[Interrupted: was about to execute ${namesStr}]`,
      };
    }

    result.push({
      role: "user",
      content: "[Capability was interrupted during previous session]",
    });
  }

  return result;
}

function hasToolResultBlocks(msg: MessageParam): boolean {
  if (typeof msg.content === "string") return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: any) => b.type === "tool_result");
}

function hasToolUseBlocks(msg: MessageParam): boolean {
  if (typeof msg.content === "string") return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: any) => b.type === "tool_use");
}

function getToolResultIds(msg: MessageParam): string[] {
  if (typeof msg.content === "string" || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b: any) => b.type === "tool_result")
    .map((b: any) => b.tool_use_id);
}

function getToolUseIds(msg: MessageParam): Set<string> {
  if (typeof msg.content === "string" || !Array.isArray(msg.content)) return new Set();
  return new Set(
    msg.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id),
  );
}

function getToolUseNames(msg: MessageParam): string[] {
  if (typeof msg.content === "string" || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => b.name);
}

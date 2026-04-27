import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { log } from "../../logger/index.js";

/**
 * Sanitize Anthropic message history before sending it to the API.
 *
 * Two failure modes the API rejects with `invalid_request_error`:
 *
 *   1. ORPHAN tool_result — a `user` message contains tool_result blocks
 *      whose tool_use_id has no matching tool_use in the immediately
 *      previous assistant message. (Original case covered by this fn.)
 *
 *   2. ORPHAN tool_use — an `assistant` message ends with tool_use blocks
 *      and the FOLLOWING message does NOT carry the corresponding
 *      tool_result blocks. Triggered when a tool call was interrupted
 *      (process restart, abort that didn't run cleanupAbortedTools, crash
 *      mid-execution) and a new user prompt arrived afterward.
 *
 * Strategy: replace orphan pairs with synthetic text turns so the API
 * sees a coherent conversation. The model loses the tool execution
 * context but the session keeps working.
 *
 * Two-pass design:
 *   - Pass A handles orphan tool_results by replacing the broken pair.
 *   - Pass B walks the resulting list and inserts a synthetic tool_result
 *     after any assistant message whose tool_use blocks aren't satisfied
 *     by the next message.
 */
export function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  return sanitizeOrphanToolUses(sanitizeOrphanToolResults(messages));
}

/** Pass A: orphan tool_result without matching tool_use. */
function sanitizeOrphanToolResults(messages: MessageParam[]): MessageParam[] {
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

/**
 * Pass B: orphan tool_use without matching tool_result.
 *
 * For each assistant message containing tool_use blocks, ensure the IMMEDIATE
 * NEXT message carries tool_result blocks for ALL of those ids. If not,
 * inject a synthetic user turn with placeholder tool_results before the next
 * message. The Anthropic API allows two consecutive user messages, so we
 * always insert a standalone synthetic turn rather than trying to merge it
 * into an existing structured user message — keeps the function pure (no
 * input mutation) and easier to reason about.
 *
 * Design choice: synthesize a tool_result rather than rewriting the
 * tool_use into a text turn. Preserves the tool name + input in history
 * (useful debugging context) and matches the shape that cleanupAbortedTools
 * produces, keeping behaviour consistent.
 */
function sanitizeOrphanToolUses(messages: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    if (!hasToolUseBlocks(msg)) continue;

    const toolUseIds = Array.from(getToolUseIds(msg));
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const nextResultIds = next ? new Set(getToolResultIds(next)) : new Set<string>();
    const orphanIds = toolUseIds.filter((id) => !nextResultIds.has(id));

    if (orphanIds.length === 0) continue;

    log.warn(
      { index: i, orphanIds, toolNames: getToolUseNames(msg) },
      "sanitizeMessages: injecting synthetic tool_result for orphan tool_use",
    );

    result.push({
      role: "user",
      content: orphanIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "[Interrupted — tool was cancelled before completing. Synthetic placeholder injected by sanitizer.]",
        is_error: true,
      })),
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

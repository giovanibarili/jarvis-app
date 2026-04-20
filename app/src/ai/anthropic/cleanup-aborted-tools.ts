import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { CapabilityCall } from "../types.js";
import { log } from "../../logger/index.js";

/**
 * Clean up message history after a tool abort.
 *
 * When the user aborts while the session is in "waiting_tools" state, the
 * Anthropic API response already yielded tool_use blocks but `addToolResults`
 * was never called (the capability execution was interrupted).
 *
 * The Anthropic API requires that every `tool_use` block in the history has a
 * matching `tool_result` block with the **same** `id`.  This function ensures
 * that invariant holds after an abort.
 *
 * There are two cases:
 *
 * 1. `streamFromAPI` skips pushing the assistant message when
 *    `stop_reason === "tool_use"`, so the tool_use blocks are NOT yet in
 *    `this.messages`.  We need to add both the assistant tool_use message and
 *    the user tool_result message.
 *
 * 2. Defensive: if for any reason an assistant message already contains some
 *    of the pending tool_use IDs (e.g. a previous partial cleanup, manual
 *    history manipulation), we only add the missing tool_result blocks.
 *
 * Key invariant enforced: **every `tool_use` ID in the history MUST have a
 * matching `tool_result` with the same ID**.
 */
export function cleanupAbortedToolMessages(
  messages: MessageParam[],
  pendingCalls: CapabilityCall[],
): MessageParam[] {
  if (pendingCalls.length === 0) return messages;

  const result = [...messages];
  const pendingIds = new Set(pendingCalls.map((c) => c.id));
  const names = pendingCalls.map((c) => c.name).join(", ");

  log.info(
    { names, pendingCount: pendingCalls.length, pendingIds: [...pendingIds] },
    "cleanupAbortedTools: processing abort cleanup",
  );

  // --- Step 1: Discover which tool_use IDs already exist in history ---
  const existingToolUseIds = new Set<string>();
  const existingToolResultIds = new Set<string>();

  for (const msg of result) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ((block as any).type === "tool_use") {
        existingToolUseIds.add((block as any).id);
      }
      if ((block as any).type === "tool_result") {
        existingToolResultIds.add((block as any).tool_use_id);
      }
    }
  }

  // --- Step 2: Determine which pending calls need tool_use and/or tool_result ---
  const needsToolUse: CapabilityCall[] = [];
  const needsToolResult: CapabilityCall[] = [];

  for (const tc of pendingCalls) {
    const hasToolUse = existingToolUseIds.has(tc.id);
    const hasToolResult = existingToolResultIds.has(tc.id);

    if (!hasToolUse) {
      needsToolUse.push(tc);
    }
    if (!hasToolResult) {
      needsToolResult.push(tc);
    }
  }

  log.info(
    {
      needsToolUse: needsToolUse.map((c) => c.id),
      needsToolResult: needsToolResult.map((c) => c.id),
    },
    "cleanupAbortedTools: gap analysis",
  );

  // --- Step 3: Add missing tool_use blocks as an assistant message ---
  if (needsToolUse.length > 0) {
    const toolUseBlocks = needsToolUse.map((tc) => ({
      type: "tool_use" as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
    result.push({ role: "assistant", content: toolUseBlocks });
  }

  // --- Step 4: Add missing tool_result blocks as a user message ---
  if (needsToolResult.length > 0) {
    const toolResultBlocks = needsToolResult.map((tc) => ({
      type: "tool_result" as const,
      tool_use_id: tc.id,
      content: "[Tool execution was aborted by user]",
      is_error: true,
    }));
    result.push({ role: "user", content: toolResultBlocks });
  }

  // --- Step 5: Final validation — ensure no orphan tool_use blocks remain ---
  const finalToolUseIds = new Set<string>();
  const finalToolResultIds = new Set<string>();

  for (const msg of result) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ((block as any).type === "tool_use") {
        finalToolUseIds.add((block as any).id);
      }
      if ((block as any).type === "tool_result") {
        finalToolResultIds.add((block as any).tool_use_id);
      }
    }
  }

  const orphanToolUseIds = [...finalToolUseIds].filter((id) => !finalToolResultIds.has(id));
  if (orphanToolUseIds.length > 0) {
    log.warn(
      { orphanToolUseIds },
      "cleanupAbortedTools: found orphan tool_use IDs without matching tool_result — adding error results",
    );
    // Emergency fix: add tool_result for any orphaned tool_use
    const emergencyResults = orphanToolUseIds.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "[Tool execution was aborted by user]",
      is_error: true,
    }));
    result.push({ role: "user", content: emergencyResults });
  }

  log.info(
    { messageCount: result.length, originalCount: messages.length },
    "cleanupAbortedTools: cleanup complete",
  );

  return result;
}

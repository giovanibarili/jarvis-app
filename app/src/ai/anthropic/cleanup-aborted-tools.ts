import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { CapabilityCall } from "../types.js";
import { log } from "../../logger/index.js";

export function cleanupAbortedToolMessages(
  messages: MessageParam[],
  pendingCalls: CapabilityCall[],
): MessageParam[] {
  const result = [...messages];
  const names = pendingCalls.map((c) => c.name).join(", ");

  const lastMsg = result[result.length - 1];
  const isScenarioA = lastMsg && hasToolResultBlocks(lastMsg);

  if (isScenarioA) {
    log.info({ names, scenario: "A" }, "cleanupAbortedTools: replacing tool pair with summary");
    result[result.length - 2] = {
      role: "assistant",
      content: `[Interrupted: was about to execute ${names}]`,
    };
    result[result.length - 1] = {
      role: "user",
      content: `[${names} was interrupted]`,
    };
  } else {
    log.info({ names, scenario: "B" }, "cleanupAbortedTools: adding interrupt context");
    result.push({
      role: "assistant",
      content: `[Interrupted: was about to execute ${names}]`,
    });
  }

  return result;
}

function hasToolResultBlocks(msg: MessageParam): boolean {
  if (typeof msg.content === "string") return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b: any) => b.type === "tool_result");
}

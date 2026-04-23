// src/pieces/choice-prompt.ts
// Choice Prompt piece — registers jarvis_ask_choice capability.
//
// Flow:
//   1. LLM calls jarvis_ask_choice(question, options, multi?, allow_other?)
//   2. Handler broadcasts an SSE event type:"choice" to the caller's session.
//      The ChatPanel renders an inline card with radio/checkbox + optional
//      "Other" free-text input and a Confirm button.
//   3. Handler returns immediately { ok: true, choice_id } — the user's
//      answer will arrive as a NEW ai.request in the next turn, formatted as
//      `[choice] <question> → <value(s)>`. The LLM simply reads the next
//      user message to continue.
//
// Persistence: the tool_use block (with {question, options, multi, choice_id})
// stays in the session history naturally. The frontend reconstructs the
// kind:'choice' entry from history via parseMessagesToHistory — marking it
// answered if a subsequent user message matches the "[choice]" prefix.

import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { ChatPiece } from "../input/chat-piece.js";
import { log } from "../logger/index.js";

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface ChoicePromptData {
  choice_id: string;
  question: string;
  options: ChoiceOption[];
  multi: boolean;
  allow_other: boolean;
}

export class ChoicePromptPiece implements Piece {
  readonly id = "choice-prompt";
  readonly name = "Choice Prompt";

  private bus!: EventBus;
  private readonly registry: CapabilityRegistry;
  private readonly chatPiece: ChatPiece;
  private counter = 0;

  constructor(registry: CapabilityRegistry, chatPiece: ChatPiece) {
    this.registry = registry;
    this.chatPiece = chatPiece;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.registerCapabilities();
    log.info("ChoicePrompt: initialized");
  }

  async stop(): Promise<void> {
    log.info("ChoicePrompt: stopped");
  }

  private nextId(): string {
    this.counter += 1;
    return `choice-${Date.now()}-${this.counter}`;
  }

  private registerCapabilities(): void {
    this.registry.register({
      name: "jarvis_ask_choice",
      description:
        "Ask the user to choose between options in the chat. Renders an inline card with radio buttons (single) or checkboxes (multi) plus an optional free-text field. The user's answer arrives as the NEXT user message formatted as `[choice] <question> → <value(s)>` — just continue from there. Use when you need a structured decision from the user (which approach, which files, yes/no, etc.) instead of free-form follow-up. The tool returns immediately; do NOT call it again for the same question.",
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question shown to the user above the options.",
          },
          options: {
            type: "array",
            description: "List of options the user can pick from.",
            items: {
              type: "object",
              properties: {
                value: { type: "string", description: "Stable machine value returned when chosen." },
                label: { type: "string", description: "Display label shown to the user." },
                description: { type: "string", description: "Optional secondary line with more detail." },
              },
              required: ["value", "label"],
            },
            minItems: 1,
          },
          multi: {
            type: "boolean",
            description: "If true, user can select multiple options (checkboxes). Default: false (radio).",
          },
          allow_other: {
            type: "boolean",
            description: "If true, include an 'Other (write your own)' option that opens a free-text field. Default: true.",
          },
        },
        required: ["question", "options"],
      },
      handler: async (input) => {
        const question = String(input.question ?? "").trim();
        const rawOptions = Array.isArray(input.options) ? input.options : [];
        const options: ChoiceOption[] = rawOptions
          .filter((o: any) => o && typeof o.value === "string" && typeof o.label === "string")
          .map((o: any) => ({
            value: String(o.value),
            label: String(o.label),
            description: o.description ? String(o.description) : undefined,
          }));

        if (!question) {
          return { ok: false, error: "question is required" };
        }
        if (options.length === 0) {
          return { ok: false, error: "at least one option is required" };
        }

        const sessionId = input.__sessionId as string | undefined;
        if (!sessionId) {
          return { ok: false, error: "no session context (internal error)" };
        }

        const multi = input.multi === true;
        const allowOther = input.allow_other !== false; // default true
        const choiceId = this.nextId();

        const data: ChoicePromptData = {
          choice_id: choiceId,
          question,
          options,
          multi,
          allow_other: allowOther,
        };

        // Push the choice card into the chat SSE stream of the caller's session.
        this.chatPiece.broadcastEvent(sessionId, {
          type: "choice",
          ...data,
          session: sessionId,
        });

        log.info({ sessionId, choiceId, multi, options: options.length }, "ChoicePrompt: published choice");

        return {
          ok: true,
          choice_id: choiceId,
          pending: true,
          message: "Choice shown to user. Their answer will arrive as the next user message.",
        };
      },
    });
  }
}

// src/pieces/choice-prompt.ts
// Choice Prompt piece — registers jarvis_ask_choice capability.
//
// Supports TWO shapes in the same tool (backward-compatible):
//   1. SINGLE question:
//      { question, options, multi?, allow_other? }
//   2. MULTIPLE questions (one card, one submit):
//      { questions: [{ question, options, multi?, allow_other? }, ...] }
//
// Flow:
//   1. LLM calls jarvis_ask_choice(...)
//   2. Handler normalizes to `questions[]` (single → array of 1)
//      and broadcasts SSE event type:"choice" to the caller's session.
//      The ChatPanel renders ONE inline card with ALL questions + single
//      Confirm. Pressing Enter also confirms (unless focus is in textarea).
//   3. Handler returns immediately { ok: true, choice_id, pending: true }.
//      The user's answer arrives as a NEW ai.request in the next turn:
//        Single question  → "[choice] <question> → <value(s)>"
//        Multi questions  → "[choice]\n<q1> → <a1>\n<q2> → <a2>\n..."
//
// Persistence: the tool_use block (with {questions}|{question,options,...})
// stays in the session history. The frontend reconstructs the kind:'choice'
// entry from history via parseMessagesToHistory — marking it answered if a
// subsequent user message matches the "[choice]" prefix (single or multi).

import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { ChatPiece } from "../input/chat-piece.js";
import type { ChatAnchorRegistry, ChatAnchorHandle } from "../chat/anchor-registry.js";
import { log } from "../logger/index.js";

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface ChoiceQuestion {
  question: string;
  options: ChoiceOption[];
  multi: boolean;
  allow_other: boolean;
}

export interface ChoicePromptData {
  choice_id: string;
  questions: ChoiceQuestion[];
  /** @deprecated kept for SSE backward-compat with older frontends */
  question?: string;
  /** @deprecated kept for SSE backward-compat with older frontends */
  options?: ChoiceOption[];
  /** @deprecated kept for SSE backward-compat with older frontends */
  multi?: boolean;
  /** @deprecated kept for SSE backward-compat with older frontends */
  allow_other?: boolean;
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────

/** Normalize raw tool input into a validated list of questions.
 *  Returns [] if nothing usable was provided.
 */
export function normalizeQuestions(input: any): ChoiceQuestion[] {
  const parseOne = (raw: any): ChoiceQuestion | null => {
    if (!raw || typeof raw !== "object") return null;
    const question = String(raw.question ?? "").trim();
    if (!question) return null;
    const rawOpts = Array.isArray(raw.options) ? raw.options : [];
    const options: ChoiceOption[] = rawOpts
      .filter((o: any) => o && typeof o.value === "string" && typeof o.label === "string")
      .map((o: any) => ({
        value: String(o.value),
        label: String(o.label),
        description: o.description ? String(o.description) : undefined,
      }));
    if (options.length === 0) return null;
    return {
      question,
      options,
      multi: raw.multi === true,
      allow_other: raw.allow_other !== false, // default true
    };
  };

  // Shape 1: { questions: [...] }
  if (Array.isArray(input?.questions)) {
    return input.questions
      .map(parseOne)
      .filter((q: ChoiceQuestion | null): q is ChoiceQuestion => q !== null);
  }
  // Shape 2: { question, options, ... }
  const single = parseOne(input);
  return single ? [single] : [];
}

export class ChoicePromptPiece implements Piece {
  readonly id = "choice-prompt";
  readonly name = "Choice Prompt";

  private bus!: EventBus;
  private readonly registry: CapabilityRegistry;
  private readonly chatPiece: ChatPiece;
  private chatAnchors?: ChatAnchorRegistry;
  /** Track open anchors per session so we can clear stale ones. */
  private openAnchors = new Map<string, ChatAnchorHandle>();
  private counter = 0;

  constructor(registry: CapabilityRegistry, chatPiece: ChatPiece) {
    this.registry = registry;
    this.chatPiece = chatPiece;
  }

  /**
   * Wire the ChatAnchorRegistry. When set, choice cards are planted as
   * anchors in the slot above the input (sticky, never scroll away). If
   * not set (e.g. tests), the piece falls back to legacy SSE
   * `type:"choice"` broadcast.
   */
  setChatAnchors(registry: ChatAnchorRegistry): void {
    this.chatAnchors = registry;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.registerCapabilities();
    log.info("ChoicePrompt: initialized");
  }

  async stop(): Promise<void> {
    // Clear any open anchors so they don't outlive the piece
    for (const h of this.openAnchors.values()) {
      try { h.clear(); } catch { /* ignore */ }
    }
    this.openAnchors.clear();
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
        "ALWAYS use this tool whenever you need to ask the user a question that has a finite set of answers. This is the ONLY correct way to ask the user to choose, confirm, pick, or decide — never dump options as plain text in your response. Triggers: any 'do you want A or B?', 'which one?', 'should I...?', 'confirm/cancel', 'pick N of these', or a small batch of related decisions. If you catch yourself about to type '1) ... 2) ... 3) ... which?', STOP and call this instead. Exceptions (do NOT use): open-ended questions with no fixed options, purely conversational prompts, or when the user explicitly asked for free-form text. Shapes: (a) single — {question, options, multi?, allow_other?}; (b) batch — {questions: [{question, options, multi?, allow_other?}, ...]}. Renders an inline card (radio/checkbox + optional 'Other' free-text); user confirms the whole card with Enter. Returns immediately with {ok:true, pending:true} — DO NOT call again for the same question; the answer arrives as the next user message prefixed with `[choice]`.",
      input_schema: {
        type: "object",
        properties: {
          // ─── Single-question shape (backward-compatible) ─────────────
          question: {
            type: "string",
            description:
              "The question shown to the user above the options. Use this for a single-question card. For multiple questions, use `questions` instead.",
          },
          options: {
            type: "array",
            description: "Options for the single-question shape (required if `question` is set).",
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
          // ─── Multi-question shape (new) ──────────────────────────────
          questions: {
            type: "array",
            description:
              "List of questions to render in ONE card. Use this instead of the top-level `question`/`options` when you need multiple decisions in a single round-trip. The user confirms all questions together with one submit.",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The question shown to the user." },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      value: { type: "string" },
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["value", "label"],
                  },
                  minItems: 1,
                },
                multi: { type: "boolean", description: "Multi-select (checkboxes) for this question." },
                allow_other: { type: "boolean", description: "Allow 'Other' free-text for this question. Default: true." },
              },
              required: ["question", "options"],
            },
            minItems: 1,
          },
        },
        // Note: we don't declare `required` because either `question` OR `questions` is valid.
        // Validation happens in the handler.
      },
      handler: async (input) => {
        const sessionId = input.__sessionId as string | undefined;
        if (!sessionId) {
          return { ok: false, error: "no session context (internal error)" };
        }

        const questions = normalizeQuestions(input);
        if (questions.length === 0) {
          return {
            ok: false,
            error:
              "must provide either (a) `question` + `options`, or (b) `questions: [{question, options, ...}]`",
          };
        }

        const choiceId = this.nextId();

        // SSE payload: include `questions` (new) AND legacy single-question
        // fields (question/options/multi/allow_other) when there's exactly
        // one question — older frontend versions still work.
        const data: ChoicePromptData = {
          choice_id: choiceId,
          questions,
        };
        if (questions.length === 1) {
          data.question = questions[0].question;
          data.options = questions[0].options;
          data.multi = questions[0].multi;
          data.allow_other = questions[0].allow_other;
        }

        // Preferred path: plant an anchor. The card stays in the slot
        // above the input until the user submits, then we clear it and
        // inject the [choice] prompt back into the chat.
        if (this.chatAnchors) {
          // Clear any stale anchor for this session — the LLM may call
          // jarvis_ask_choice again before the user answered the previous
          // one. We keep the latest only (matches the "[choice] prefix"
          // convention; only one in-flight choice at a time).
          const stale = this.openAnchors.get(sessionId);
          if (stale) { try { stale.clear(); } catch { /* ignore */ } }

          const handle = this.chatAnchors.set({
            id: choiceId,
            sessionId,
            source: this.id,
            renderer: { builtin: "choice-card" },
            data: data as unknown as Record<string, unknown>,
            onAction: (payload: any) => {
              // payload = { prompt: string }, where `prompt` is the
              // serialized "[choice]\n…" string the frontend built from
              // the user's selections. We:
              //   1. Clear the anchor so the slot frees up
              //   2. Forget our handle
              //   3. Inject a new ai.request so the LLM sees the answer
              //      as the next user message in this session.
              try { handle.clear(); } catch { /* ignore */ }
              if (this.openAnchors.get(sessionId) === handle) {
                this.openAnchors.delete(sessionId);
              }
              const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
              if (!prompt) return;
              this.bus.publish({
                channel: "ai.request",
                source: this.id,
                target: sessionId,
                text: prompt,
              });
            },
          });
          this.openAnchors.set(sessionId, handle);
        } else {
          // Fallback: legacy SSE broadcast for environments without the
          // anchor registry (e.g. unit tests, embedded headless usage).
          this.chatPiece.broadcastEvent(sessionId, {
            type: "choice",
            ...data,
            session: sessionId,
          });
        }

        log.info(
          { sessionId, choiceId, questions: questions.length, mode: this.chatAnchors ? "anchor" : "legacy" },
          "ChoicePrompt: published choice",
        );

        return {
          ok: true,
          choice_id: choiceId,
          pending: true,
          questions: questions.length,
          message: "Choice shown to user. Their answer will arrive as the next user message.",
        };
      },
    });
  }
}

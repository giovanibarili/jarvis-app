import { describe, it, expect } from "vitest";
import { parseMessagesToHistory } from "./chat-piece.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function toolUse(id: string, name: string, input: any) {
  return { type: "tool_use", id, name, input };
}
function assistant(blocks: any[]) {
  return { role: "assistant" as const, content: blocks };
}
function userText(text: string) {
  return { role: "user" as const, content: text };
}
function userToolResult() {
  return { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] };
}
function text(t: string) {
  return { type: "text", text: t };
}

// ─── Basic single-question ──────────────────────────────────────────────────

describe("parseMessagesToHistory — single choice", () => {
  it("matches simple single-question with label answer", () => {
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        question: "Color?",
        options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }],
      })]),
      userText("[choice] Color? → Green"),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices).toHaveLength(1);
    expect(choices[0].answers).toEqual([{ values: ["g"] }]);
  });

  it("handles single-question where label contains a comma — greedy longest-match", () => {
    // Regression test for bug #1: a label like "C) Foo, bar" would be split by
    // the naive /,\s+/ splitter, breaking label-to-value mapping.
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        question: "Option?",
        options: [
          { value: "a", label: "A) Simple" },
          { value: "b", label: "B) Medium, with commas" },
          { value: "c", label: "C) Complex, multi, commas" },
        ],
      })]),
      userText("[choice] Option? → C) Complex, multi, commas"),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices[0].answers).toEqual([{ values: ["c"] }]);
  });

  it("single-question 'Other' free-text is preserved exactly", () => {
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        question: "Lang?",
        options: [{ value: "clj", label: "Clojure" }, { value: "ts", label: "TypeScript" }],
      })]),
      userText("[choice] Lang? → Haskell, of course"),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices[0].answers).toEqual([{ values: ["__other__"], otherText: "Haskell, of course" }]);
  });
});

// ─── Multi-question ─────────────────────────────────────────────────────────

describe("parseMessagesToHistory — multi-question", () => {
  it("matches 3-question multi-line answer", () => {
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        questions: [
          { question: "Q1?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
          { question: "Q2?", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
          { question: "Q3?", options: [{ value: "1", label: "One" }, { value: "2", label: "Two" }], multi: true },
        ],
      })]),
      userText("[choice]\nQ1? → A\nQ2? → Y\nQ3? → One, Two"),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices[0].answers).toEqual([
      { values: ["a"] },
      { values: ["y"] },
      { values: ["1", "2"] },
    ]);
  });

  it("multi-select with free-text in one slot", () => {
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        questions: [
          { question: "A?", options: [{ value: "1", label: "One" }, { value: "2", label: "Two" }] },
          { question: "B?", options: [{ value: "x", label: "Known" }] },
        ],
      })]),
      userText("[choice]\nA? → One\nB? → unknown free text"),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices[0].answers).toEqual([
      { values: ["1"] },
      { values: ["__other__"], otherText: "unknown free text" },
    ]);
  });
});

// ─── Out-of-order / interleaved choices (bug #2) ────────────────────────────

describe("parseMessagesToHistory — pending choice queue", () => {
  it("pairs answers correctly when two choices are opened before either is answered", () => {
    // Regression test for bug #2: the old singular `pendingChoice` was
    // overwritten when a second choice opened before the first was answered.
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        question: "First?",
        options: [{ value: "a", label: "AnswerA" }],
      })]),
      userToolResult(),
      assistant([
        text("reasoning"),
        toolUse("c2", "jarvis_ask_choice", {
          questions: [
            { question: "Lang?", options: [{ value: "clj", label: "Clojure" }] },
            { question: "Editor?", options: [{ value: "vim", label: "Vim" }] },
          ],
        }),
      ]),
      userToolResult(),
      userText("[choice] First? → AnswerA"),
      userText("[choice]\nLang? → Clojure\nEditor? → Vim"),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices).toHaveLength(2);
    expect(choices[0].answers).toEqual([{ values: ["a"] }]);
    expect(choices[1].answers).toEqual([
      { values: ["clj"] },
      { values: ["vim"] },
    ]);
  });

  it("still works when answers arrive in the OPPOSITE order (reverse of call order)", () => {
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        question: "First?",
        options: [{ value: "a", label: "Alfa" }],
      })]),
      userToolResult(),
      assistant([toolUse("c2", "jarvis_ask_choice", {
        question: "Second?",
        options: [{ value: "b", label: "Bravo" }],
      })]),
      userToolResult(),
      // User answers Second BEFORE First
      userText("[choice] Second? → Bravo"),
      userText("[choice] First? → Alfa"),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices[0].answers).toEqual([{ values: ["a"] }]);
    expect(choices[1].answers).toEqual([{ values: ["b"] }]);
  });

  it("unanswered choice remains without 'answers' field", () => {
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        question: "Pending?",
        options: [{ value: "x", label: "X" }],
      })]),
    ]);
    const choices = parsed.filter(e => e.kind === "choice");
    expect(choices).toHaveLength(1);
    expect(choices[0].answers).toBeUndefined();
  });

  it("[choice] message that doesn't match any pending choice is emitted as a normal user message", () => {
    const parsed = parseMessagesToHistory([
      userText("[choice] Orphan? → Whatever"),
    ]);
    expect(parsed).toEqual([
      { kind: "message", role: "user", text: "[choice] Orphan? → Whatever", source: "chat" },
    ]);
  });
});

// ─── End-to-end shape sanity ────────────────────────────────────────────────

describe("parseMessagesToHistory — general shape", () => {
  it("preserves question metadata in questions[]", () => {
    const parsed = parseMessagesToHistory([
      assistant([toolUse("c1", "jarvis_ask_choice", {
        question: "Q?",
        options: [{ value: "a", label: "A", description: "the a" }],
        multi: false,
        allow_other: false,
      })]),
    ]);
    const choice = parsed.find(e => e.kind === "choice");
    expect(choice.questions).toHaveLength(1);
    expect(choice.questions[0]).toMatchObject({
      question: "Q?",
      multi: false,
      allow_other: false,
    });
    expect(choice.questions[0].options[0]).toMatchObject({ value: "a", label: "A", description: "the a" });
  });
});

import { describe, it, expect } from "vitest";
import { unescapeLiteralUnicode, unescapeToolInput } from "./unescape-tool-input.js";

describe("unescapeLiteralUnicode", () => {
  it("returns the input unchanged when no escape is present", () => {
    expect(unescapeLiteralUnicode("hello world")).toBe("hello world");
    expect(unescapeLiteralUnicode("já com acento")).toBe("já com acento");
    expect(unescapeLiteralUnicode("")).toBe("");
  });

  it("converts a single \\uXXXX escape to the matching char", () => {
    // \u00e7 → ç
    expect(unescapeLiteralUnicode("Ter\\u00e7a")).toBe("Terça");
    // \u00e9 → é
    expect(unescapeLiteralUnicode("\\u00e9 repo pessoal")).toBe("é repo pessoal");
  });

  it("converts multiple escapes within the same string", () => {
    const input = "Ter\\u00e7a 08:51 BRT, fora da janela 10\\u201317h \\u2014 mas \\u00e9 repo pessoal, n\\u00e3o prod Nu";
    const expected = "Terça 08:51 BRT, fora da janela 10–17h — mas é repo pessoal, não prod Nu";
    expect(unescapeLiteralUnicode(input)).toBe(expected);
  });

  it("handles uppercase hex digits", () => {
    expect(unescapeLiteralUnicode("\\u00E7")).toBe("ç");
    expect(unescapeLiteralUnicode("\\u00C7")).toBe("Ç");
  });

  it("handles surrogate pairs (astral plane chars like emoji)", () => {
    // 😀 = U+1F600 = surrogate pair \uD83D\uDE00
    expect(unescapeLiteralUnicode("\\uD83D\\uDE00")).toBe("😀");
    expect(unescapeLiteralUnicode("hi \\uD83D\\uDE00 there")).toBe("hi 😀 there");
  });

  it("is idempotent — running twice yields the same result", () => {
    const once = unescapeLiteralUnicode("Ter\\u00e7a");
    const twice = unescapeLiteralUnicode(once);
    expect(twice).toBe(once);
    expect(twice).toBe("Terça");
  });

  it("does NOT touch other backslash escapes", () => {
    // \n, \t, \\, \" must survive untouched — they are legitimate user content
    expect(unescapeLiteralUnicode("line1\\nline2")).toBe("line1\\nline2");
    expect(unescapeLiteralUnicode("a\\tb")).toBe("a\\tb");
    expect(unescapeLiteralUnicode("path\\\\file")).toBe("path\\\\file");
    expect(unescapeLiteralUnicode('say \\"hi\\"')).toBe('say \\"hi\\"');
  });

  it("does NOT touch malformed/partial escapes", () => {
    // \u followed by < 4 hex digits is left alone
    expect(unescapeLiteralUnicode("\\u00")).toBe("\\u00");
    expect(unescapeLiteralUnicode("\\uZZZZ")).toBe("\\uZZZZ");
    expect(unescapeLiteralUnicode("\\u")).toBe("\\u");
  });
});

describe("unescapeToolInput", () => {
  it("passes primitives through unchanged", () => {
    expect(unescapeToolInput(42)).toBe(42);
    expect(unescapeToolInput(true)).toBe(true);
    expect(unescapeToolInput(null)).toBe(null);
    expect(unescapeToolInput(undefined)).toBe(undefined);
  });

  it("unescapes a top-level string", () => {
    expect(unescapeToolInput("Ter\\u00e7a")).toBe("Terça");
  });

  it("unescapes string properties of a plain object", () => {
    const input = {
      question: "Ter\\u00e7a?",
      count: 3,
      ok: true,
      tag: null,
    };
    expect(unescapeToolInput(input)).toEqual({
      question: "Terça?",
      count: 3,
      ok: true,
      tag: null,
    });
  });

  it("unescapes strings inside nested arrays and objects", () => {
    const input = {
      question: "Op\\u00e7\\u00e3o?",
      options: [
        { value: "y", label: "Sim, j\\u00e1" },
        { value: "n", label: "N\\u00e3o" },
      ],
    };
    expect(unescapeToolInput(input)).toEqual({
      question: "Opção?",
      options: [
        { value: "y", label: "Sim, já" },
        { value: "n", label: "Não" },
      ],
    });
  });

  it("returns a copy (does not mutate the original)", () => {
    const input = { q: "Ter\\u00e7a" };
    const out = unescapeToolInput(input);
    expect(out).not.toBe(input);
    expect(input.q).toBe("Ter\\u00e7a");
    expect(out.q).toBe("Terça");
  });

  it("handles deeply nested structures", () => {
    const input = {
      questions: [
        {
          question: "Q1 \\u00e7?",
          options: [{ value: "a", label: "A \\u00e9" }],
        },
      ],
    };
    const out = unescapeToolInput(input);
    expect(out.questions[0].question).toBe("Q1 ç?");
    expect(out.questions[0].options[0].label).toBe("A é");
  });

  it("is cycle-safe", () => {
    const a: { name: string; child?: unknown } = { name: "Ter\\u00e7a" };
    a.child = a;
    // Should not throw / loop forever
    const out = unescapeToolInput(a);
    expect(out.name).toBe("Terça");
  });

  it("leaves non-plain objects alone (Date, etc.)", () => {
    const d = new Date(0);
    const input = { when: d, label: "Ter\\u00e7a" };
    const out = unescapeToolInput(input) as { when: Date; label: string };
    expect(out.when).toBe(d); // same reference, untouched
    expect(out.label).toBe("Terça");
  });

  it("is idempotent on full structures", () => {
    const input = { q: "Ter\\u00e7a", opts: [{ label: "N\\u00e3o" }] };
    const once = unescapeToolInput(input);
    const twice = unescapeToolInput(once);
    expect(twice).toEqual(once);
  });
});

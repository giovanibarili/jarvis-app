/**
 * Anthropic tool_use input sanitizer — surgical fix for a known model quirk.
 *
 * BACKGROUND
 * ----------
 * The Anthropic Messages API delivers `tool_use` blocks with a parsed `input`
 * object. The model occasionally emits the JSON of that input with
 * DOUBLE-ESCAPED Unicode literals — e.g. it writes `"Ter\\u00e7a"` (8 chars
 * literal: T,e,r,\,u,0,0,e,7,a) in the JSON stream instead of either the
 * single-escaped form `"Ter\u00e7a"` (which decodes to `"Terça"`) or the raw
 * UTF-8 char. The SDK's underlying `JSON.parse` runs once, so what was meant
 * to be a `ç` ends up in our hands as the literal 6-char sequence `\u00e7`.
 *
 * This is rare but reproducible: Opus 4.7 has been observed mixing escaped
 * and native UTF-8 across consecutive tool_use blocks in the same turn, with
 * roughly 1-in-20 frequency on prompts containing mixed Latin/CJK/emoji
 * input. Affected paths today: any tool whose argument is a user-visible
 * string (jarvis_ask_choice questions/labels, hud renderer payloads, etc.).
 *
 * STRATEGY
 * --------
 * Walk the input value tree and, on every string leaf, replace any literal
 * `\uXXXX` (six-char) sequence with the actual codepoint. Surrogate pairs
 * (`\uD83D\uDE00` → 😀) are reassembled. Other backslash escapes (`\n`,
 * `\t`, `\\`, `\"`, …) are intentionally left alone — those forms are
 * legitimately produced by users (e.g. a bash command containing `\n`),
 * and the observed bug only manifests on the Unicode escape form.
 *
 * Idempotent: a clean string (no `\uXXXX` literals) round-trips unchanged.
 */

const UNICODE_ESCAPE_RE = /\\u([0-9a-fA-F]{4})/g;

/**
 * Replace `\uXXXX` literals in a string with the corresponding char.
 * Pairs of high+low surrogates are joined into a single astral codepoint.
 */
export function unescapeLiteralUnicode(input: string): string {
  if (input.indexOf("\\u") === -1) return input;
  // Single regex replace handles BMP. Adjacent surrogate pairs decode as two
  // sequential chars, which JavaScript strings already represent natively as
  // two UTF-16 code units — so the result string holds the astral char.
  return input.replace(UNICODE_ESCAPE_RE, (_match, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Recursively walk an arbitrary value, returning a copy with every string
 * leaf passed through {@link unescapeLiteralUnicode}.
 *
 * Cycle-safe: tracks visited objects to avoid infinite recursion on shared
 * refs (rare in JSON-shaped data but defensive).
 *
 * Preserves type for non-string primitives (number/boolean/null/undefined).
 * Arrays and plain objects are deep-copied so callers can mutate safely.
 * Class instances (Date, Map, etc.) are passed through untouched — tool
 * inputs from the API are always plain JSON, so this branch is unreachable
 * in practice but keeps the helper safe in tests.
 */
export function unescapeToolInput<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") {
    return unescapeLiteralUnicode(value) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => unescapeToolInput(v, seen)) as unknown as T;
  }
  // Only descend into plain objects. Anything with a non-Object prototype
  // (Date, Map, custom classes) is left as-is.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = unescapeToolInput((value as Record<string, unknown>)[k], seen);
  }
  return out as unknown as T;
}

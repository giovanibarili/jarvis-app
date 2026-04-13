# Chat Visual Feedback + Esc Abort — Design Spec

## Goal

Add visual feedback to JARVIS chat (tool execution, streaming, abort states) and simplify Esc to a single-action abort that preserves partial responses.

## Esc Behavior

Esc aborts whatever is currently running. One press, one action. Partial responses are always preserved.

- **waiting_tools** → cancels the tool, returns partial result to model, model responds with what it has
- **processing (streaming)** → stops the stream, partial text stays visible with `⊘ interrupted` indicator
- **idle** → nothing

New message (Enter while processing) → interrupts and substitutes (existing behavior, unchanged).

## Chat Visual Elements

### Tool Execution Bar

Compact bar between user message and JARVIS response. Shows which tool is running.

- **Running**: `⚡ running read_file...` with pulse animation, yellow left border
- **Complete**: collapses to `✓ read_file 120ms` chip (green, compact)
- **Cancelled**: `⊘ read_file cancelled` (dim, italic)

### Streaming Cursor

Green blinking cursor at the end of JARVIS text while streaming. Disappears on completion.

### Interrupted Indicator

When Esc aborts a stream, partial text remains with dim italic `⊘ interrupted` label at the end. No text is lost.

## New SSE Events

Current events: `user`, `delta`, `done`, `error`.

New events to add:

- `tool_start` — `{ type: "tool_start", name: "read_file", id: "toolu_abc" }`
- `tool_done` — `{ type: "tool_done", name: "read_file", id: "toolu_abc", ms: 120 }`
- `tool_cancelled` — `{ type: "tool_cancelled", name: "read_file", id: "toolu_abc" }`
- `aborted` — `{ type: "aborted" }` (stream was interrupted by user)

## Files Impacted

**Backend (3 files):**
- `jarvis.ts` — emit tool_start/tool_done/tool_cancelled events on the ai.stream bus channel
- `chat-piece.ts` — broadcast new event types to SSE clients
- `session.ts` — on abort, preserve partial assistant message in history

**Frontend (1 file):**
- `ChatOutput.tsx` — render tool bar, streaming cursor, interrupted indicator based on new events

## Out of Scope

- Tool output preview in the chat (showing what bash returned)
- Multiple concurrent tool execution display
- Keyboard shortcut customization

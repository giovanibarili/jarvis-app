// src/core/conversation-store.ts
// Persists conversation message history to disk for session recovery across restarts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger/index.js";

export interface StoredConversation {
  sessionId: string;
  provider: string;
  model: string;
  messages: unknown[];
  savedAt: string;
  messageCount: number;
}

const SESSIONS_DIR = join(process.cwd(), ".jarvis", "sessions");
const MAX_MESSAGES = 200; // Keep last N messages to avoid context overflow

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function filePath(sessionLabel: string): string {
  // Sanitize label for filename
  const safe = sessionLabel.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(SESSIONS_DIR, `${safe}.json`);
}

/** Save conversation messages to disk */
export function saveConversation(
  sessionLabel: string,
  messages: unknown[],
  provider: string,
  model: string,
): void {
  try {
    ensureDir();
    // Trim to max messages (keep most recent), ensuring we start on a user message
    // to avoid orphaned assistant/tool_result messages at the start
    let trimmed = messages;
    if (messages.length > MAX_MESSAGES) {
      trimmed = messages.slice(messages.length - MAX_MESSAGES);
      // Walk forward to find the first user message to ensure valid conversation start
      const firstUserIdx = trimmed.findIndex((m: any) => m.role === "user");
      if (firstUserIdx > 0) {
        trimmed = trimmed.slice(firstUserIdx);
      }
    }

    const data: StoredConversation = {
      sessionId: sessionLabel,
      provider,
      model,
      messages: trimmed,
      savedAt: new Date().toISOString(),
      messageCount: trimmed.length,
    };

    writeFileSync(filePath(sessionLabel), JSON.stringify(data, null, 2), "utf-8");
    log.debug({ sessionLabel, messageCount: trimmed.length }, "ConversationStore: saved");
  } catch (err) {
    log.error({ sessionLabel, err }, "ConversationStore: save failed");
  }
}

/** Load conversation messages from disk. Returns null if not found or incompatible. */
export function loadConversation(
  sessionLabel: string,
  expectedProvider: string,
): StoredConversation | null {
  try {
    const path = filePath(sessionLabel);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path, "utf-8");
    const data: StoredConversation = JSON.parse(raw);

    // Don't restore if provider changed (message format differs between Anthropic/OpenAI)
    if (data.provider !== expectedProvider) {
      log.info(
        { sessionLabel, savedProvider: data.provider, currentProvider: expectedProvider },
        "ConversationStore: provider mismatch, discarding saved conversation",
      );
      return null;
    }

    log.info(
      { sessionLabel, messageCount: data.messageCount, savedAt: data.savedAt },
      "ConversationStore: loaded",
    );
    return data;
  } catch (err) {
    log.error({ sessionLabel, err }, "ConversationStore: load failed");
    return null;
  }
}

/** Clear saved conversation for a session */
export function clearConversation(sessionLabel: string): void {
  try {
    const path = filePath(sessionLabel);
    if (existsSync(path)) {
      unlinkSync(path);
      log.info({ sessionLabel }, "ConversationStore: cleared");
    }
  } catch (err) {
    log.error({ sessionLabel, err }, "ConversationStore: clear failed");
  }
}

// --- Startup Prompt ---
// A one-shot message file that JARVIS reads on boot and sends as first ai.request.
// Written by jarvis_reset or manually. Deleted after reading.

const STARTUP_PROMPT_PATH = join(process.cwd(), ".jarvis", "startup-prompt.txt");

/** Save a startup prompt to be sent on next boot */
export function saveStartupPrompt(text: string): void {
  try {
    ensureDir();
    writeFileSync(STARTUP_PROMPT_PATH, text, "utf-8");
    log.info({ length: text.length }, "ConversationStore: startup prompt saved");
  } catch (err) {
    log.error({ err }, "ConversationStore: startup prompt save failed");
  }
}

/** Load and consume (delete) the startup prompt. Returns null if none. */
export function consumeStartupPrompt(): string | null {
  try {
    if (!existsSync(STARTUP_PROMPT_PATH)) return null;
    const text = readFileSync(STARTUP_PROMPT_PATH, "utf-8").trim();
    unlinkSync(STARTUP_PROMPT_PATH);
    if (!text) return null;
    log.info({ length: text.length }, "ConversationStore: startup prompt consumed");
    return text;
  } catch (err) {
    log.error({ err }, "ConversationStore: startup prompt consume failed");
    return null;
  }
}

/** Clear all saved conversations */
export function clearAllConversations(): void {
  try {
    if (!existsSync(SESSIONS_DIR)) return;
    const files = readdirSync(SESSIONS_DIR);
    for (const f of files) {
      if (f.endsWith(".json")) {
        unlinkSync(join(SESSIONS_DIR, f));
      }
    }
    log.info("ConversationStore: cleared all");
  } catch (err) {
    log.error({ err }, "ConversationStore: clearAll failed");
  }
}

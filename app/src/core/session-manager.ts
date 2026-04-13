// src/core/session-manager.ts
import type { AISession, AISessionFactory } from "../ai/types.js";
import { log } from "../logger/index.js";
import {
  saveConversation,
  loadConversation,
  clearConversation,
} from "./conversation-store.js";
import { config } from "../config/index.js";

type SessionState = "idle" | "processing" | "waiting_tools";

interface ManagedSession {
  session: AISession;
  state: SessionState;
  createdAt: number;
  pendingToolCalls?: import("../ai/types.js").CapabilityCall[];
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private factory: AISessionFactory;
  private currentProvider: string = "anthropic";
  private autoSaveTimer?: ReturnType<typeof setInterval>;
  private static AUTO_SAVE_INTERVAL_MS = 30_000; // save every 30s

  constructor(factory: AISessionFactory) {
    this.factory = factory;
  }

  /** Set current provider name (needed for save/restore compatibility checks) */
  setProvider(provider: string): void {
    this.currentProvider = provider;
  }

  /** Start auto-saving conversation state periodically */
  startAutoSave(): void {
    if (this.autoSaveTimer) return;
    this.autoSaveTimer = setInterval(() => this.saveAll(), SessionManager.AUTO_SAVE_INTERVAL_MS);
    log.info({ intervalMs: SessionManager.AUTO_SAVE_INTERVAL_MS }, "SessionManager: auto-save started");
  }

  /** Stop auto-save timer */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
  }

  get(sessionId: string): ManagedSession {
    let managed = this.sessions.get(sessionId);
    if (!managed) {
      // Try to load saved conversation for restore
      const saved = loadConversation(sessionId, this.currentProvider);
      const restoreMessages = saved && saved.messages.length > 0 ? saved.messages : undefined;

      // Factory handles restore — each provider knows its own message format
      const session = this.factory.create({ label: sessionId, restoreMessages });

      if (restoreMessages) {
        log.info(
          { sessionId, restored: saved!.messageCount, savedAt: saved!.savedAt },
          "SessionManager: conversation restored via factory",
        );
      }

      managed = {
        session,
        state: "idle",
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, managed);
      log.info({ sessionId, restored: !!restoreMessages }, "SessionManager: created new session");
    }
    return managed;
  }

  setState(sessionId: string, state: SessionState): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.state = state;
      log.debug({ sessionId, state }, "SessionManager: state changed");

      // Save after each complete turn (when going back to idle)
      if (state === "idle") {
        this.save(sessionId);
      }
    }
  }

  getState(sessionId: string): SessionState {
    return this.sessions.get(sessionId)?.state ?? "idle";
  }

  abort(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.session.abort();
      managed.pendingToolCalls = undefined;
      managed.state = "idle";
      log.info({ sessionId }, "SessionManager: aborted");
    }
  }

  /** Save a single session's conversation to disk */
  save(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      saveConversation(
        sessionId,
        managed.session.getMessages(),
        this.currentProvider,
        config.model,
      );
    }
  }

  /** Save all active sessions to disk */
  saveAll(): void {
    for (const [id] of this.sessions) {
      this.save(id);
    }
  }

  close(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      // Save before closing
      this.save(sessionId);
      managed.session.close();
      this.sessions.delete(sessionId);
      log.info({ sessionId }, "SessionManager: closed");
    }
  }

  /** Clear saved conversation for a session (e.g. on explicit /clear command) */
  clearSaved(sessionId: string): void {
    clearConversation(sessionId);
  }

  updateFactory(factory: AISessionFactory): void {
    this.factory = factory;
    this.closeAll();
    log.info("SessionManager: factory updated, sessions cleared");
  }

  closeAll(): void {
    // Save all before closing
    this.saveAll();
    for (const [id] of this.sessions) {
      const managed = this.sessions.get(id);
      if (managed) {
        managed.session.close();
        this.sessions.delete(id);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}

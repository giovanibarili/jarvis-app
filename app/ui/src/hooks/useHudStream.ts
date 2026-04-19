// ui/src/hooks/useHudStream.ts
// Reactive HUD state via SSE. Backend pushes deltas per-piece.
//
// Architecture:
//   - Single SSE connection to /hud-stream shared by all consumers
//   - Internal Map<pieceId, HudComponentState> updated on every delta
//   - useHudState()      → full HudState (reactor + components array) — used by HudRenderer
//   - useHudPiece(id)    → single piece state — used by plugin renderers
//   - useHudReactor()    → reactor state only — used by core node overlay
//
// Plugins access these via window.__JARVIS_HUD_HOOKS (injected in App.tsx)

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import type { HudState, HudComponentState, HudReactor } from '../types/hud'

const DEFAULT_REACTOR: HudReactor = { status: 'offline', coreLabel: 'CONNECTING', coreSubLabel: '...' }

interface HudDelta {
  action: 'snapshot' | 'set' | 'remove'
  pieceId?: string
  component?: HudComponentState
  reactor?: HudReactor
  state?: HudState
}

// ─── Singleton Store ──────────────────────────────────────────────────────────
// One SSE connection, many subscribers. Components subscribe to specific pieces
// and only re-render when their piece changes.

type Listener = () => void

class HudStore {
  private components = new Map<string, HudComponentState>()
  private reactor: HudReactor = DEFAULT_REACTOR
  private listeners = new Set<Listener>()
  private es: EventSource | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private refCount = 0
  // Snapshot version — bumped on every mutation to trigger useSyncExternalStore
  private version = 0

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    this.refCount++
    if (this.refCount === 1) this.connect()
    return () => {
      this.listeners.delete(listener)
      this.refCount--
      if (this.refCount === 0) this.disconnect()
    }
  }

  getReactor(): HudReactor { return this.reactor }
  getComponents(): Map<string, HudComponentState> { return this.components }
  getVersion(): number { return this.version }

  getPiece(id: string): HudComponentState | undefined {
    return this.components.get(id)
  }

  private notify() {
    this.version++
    for (const l of this.listeners) l()
  }

  private connect() {
    if (this.es) return
    const es = new EventSource('/hud-stream')
    this.es = es

    es.onmessage = (event) => {
      try {
        const delta: HudDelta = JSON.parse(event.data)
        this.applyDelta(delta)
      } catch { /* ignore parse errors */ }
    }

    es.onerror = () => {
      es.close()
      this.es = null
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => this.connect(), 2000)
    }
  }

  private disconnect() {
    if (this.es) { this.es.close(); this.es = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  private applyDelta(delta: HudDelta) {
    switch (delta.action) {
      case 'snapshot': {
        if (delta.state) {
          this.components = new Map()
          for (const comp of delta.state.components) {
            this.components.set(comp.id, comp)
          }
          this.reactor = delta.state.reactor
          this.notify()
        }
        break
      }
      case 'set': {
        if (delta.pieceId && delta.component) {
          this.components.set(delta.pieceId, delta.component)
        }
        if (delta.reactor) this.reactor = delta.reactor
        this.notify()
        break
      }
      case 'remove': {
        if (delta.pieceId) {
          this.components.delete(delta.pieceId)
        }
        if (delta.reactor) this.reactor = delta.reactor
        this.notify()
        break
      }
    }
  }
}

// Single global instance
const store = new HudStore()

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Full HudState — used by HudRenderer / App */
export function useHudState(): HudState {
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getVersion(),
  )
  // Rebuild array only when version changes
  const reactor = store.getReactor()
  const components = [...store.getComponents().values()]
  return { reactor, components }
}

/** Single piece state — used by plugin renderers and built-in renderers */
export function useHudPiece(pieceId: string): HudComponentState | undefined {
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getVersion(),
  )
  return store.getPiece(pieceId)
}

/** Reactor state only — used by core node overlay */
export function useHudReactor(): HudReactor {
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getVersion(),
  )
  return store.getReactor()
}

// Backward compatibility
export { useHudState as useHudStream }

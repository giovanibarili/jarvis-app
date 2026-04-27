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

import { useSyncExternalStore } from 'react'
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

  // ─── Cached snapshots (stable reference across reads with same version) ──
  // Each is invalidated lazily by `notify()` and re-built on first read.
  private stateCache: HudState | null = null
  private stateCacheVersion = -1
  // Per-piece snapshot cache. Returns the SAME reference until that piece
  // (or a global mutation) bumps the version.
  private pieceCache = new Map<string, { v: number; piece: HudComponentState | undefined }>()

  // Bound once — stable reference passed to `useSyncExternalStore`. Without
  // this, callers would create a fresh `(cb) => store.subscribe(cb)` per
  // render and React would re-subscribe each time, churning the SSE
  // connection.
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    this.refCount++
    if (this.refCount === 1) this.connect()
    return () => {
      this.listeners.delete(listener)
      this.refCount--
      if (this.refCount === 0) this.disconnect()
    }
  }

  // Bound — stable function reference for getSnapshot.
  readonly getVersion = (): number => this.version

  getReactor(): HudReactor { return this.reactor }
  getComponents(): Map<string, HudComponentState> { return this.components }

  /** Stable HudState snapshot. Same reference until version changes. */
  getStateSnapshot(): HudState {
    if (this.stateCache && this.stateCacheVersion === this.version) {
      return this.stateCache
    }
    this.stateCache = {
      reactor: this.reactor,
      components: [...this.components.values()],
    }
    this.stateCacheVersion = this.version
    return this.stateCache
  }

  /** Stable per-piece snapshot. Same reference until version changes. */
  getPiece(id: string): HudComponentState | undefined {
    const cached = this.pieceCache.get(id)
    if (cached && cached.v === this.version) return cached.piece
    const piece = this.components.get(id)
    this.pieceCache.set(id, { v: this.version, piece })
    return piece
  }

  private notify() {
    this.version++
    // Invalidate caches — they'll be rebuilt lazily on next read.
    this.stateCache = null
    this.stateCacheVersion = -1
    this.pieceCache.clear()
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

// ─── Hook helpers ────────────────────────────────────────────────────────────
//
// Each hook passes the bound `store.subscribe` and `store.getVersion`
// directly — both are stable references across renders, so React keeps
// the same subscription instead of churning it.
//
// We then read the cached snapshot AFTER `useSyncExternalStore`. Reading
// it inside the hook (not as the third arg) is fine because
// `useSyncExternalStore` already guarantees a render whenever version
// changes; the cached snapshot is referentially stable per version, so
// downstream `===` checks (memo, useMemo deps) short-circuit correctly.

/** Full HudState — used by HudRenderer / App */
export function useHudState(): HudState {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store.getStateSnapshot()
}

/** Single piece state — used by plugin renderers and built-in renderers */
export function useHudPiece(pieceId: string): HudComponentState | undefined {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store.getPiece(pieceId)
}

/** Reactor state only — used by core node overlay */
export function useHudReactor(): HudReactor {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store.getReactor()
}

// Backward compatibility
export { useHudState as useHudStream }

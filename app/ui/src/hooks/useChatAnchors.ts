// app/ui/src/hooks/useChatAnchors.ts
//
// React hook that long-polls /chat/anchors for a session and returns the
// current list of anchor entries planted in that session's anchor zone
// (the slot above the chat input). Each panel mounts its own connection
// scoped to its sessionId — there is no global cache because anchors are
// session-local.
//
// Lifecycle:
//   1. Mount → initial GET (no `since`) returns the snapshot + version.
//   2. Loop:  GET ?since=<version> → blocks up to 25s (or returns
//      immediately if a mutation happened). On response, replace state
//      and re-issue with the new version.
//   3. Errors / aborts → exponential backoff (1s, 2s, 4s … capped at 30s)
//      and resume. Aborted on unmount via AbortController.

import { useEffect, useState } from 'react'

export interface ChatAnchorRendererBuiltin {
  builtin: 'choice-card'
  plugin?: undefined
  file?: undefined
}

export interface ChatAnchorRendererPlugin {
  builtin?: undefined
  plugin: string
  file: string
}

export type ChatAnchorRenderer = ChatAnchorRendererBuiltin | ChatAnchorRendererPlugin

export interface ChatAnchorEntry {
  id: string
  source: string
  renderer: ChatAnchorRenderer
  data: Record<string, unknown>
  version: number
  order: number
}

interface AnchorsResponse {
  version: number
  anchors: ChatAnchorEntry[]
}

/**
 * Subscribe to the anchor list for `sessionId`. Real-time updates via
 * HTTP long-poll. Returns the current snapshot (empty array until the
 * first response).
 *
 * `baseUrl` is the JARVIS HTTP server URL. Pass `""` (empty string) to
 * use same-origin relative URLs — that's the default for in-app panels.
 */
export function useChatAnchors(baseUrl: string, sessionId: string): ChatAnchorEntry[] {
  const [anchors, setAnchors] = useState<ChatAnchorEntry[]>([])

  useEffect(() => {
    if (!sessionId) {
      setAnchors([])
      return
    }

    let cancelled = false
    let abortCtrl = new AbortController()
    let backoffMs = 1000

    const sortByOrder = (xs: ChatAnchorEntry[]): ChatAnchorEntry[] =>
      [...xs].sort((a, b) => a.order - b.order)

    async function loop() {
      // Initial snapshot — no `since` so the server returns immediately.
      let version = -1
      while (!cancelled) {
        try {
          abortCtrl = new AbortController()
          const url =
            version < 0
              ? `${baseUrl}/chat/anchors?sessionId=${encodeURIComponent(sessionId)}`
              : `${baseUrl}/chat/anchors?sessionId=${encodeURIComponent(sessionId)}&since=${version}&timeoutMs=25000`

          const res = await fetch(url, { signal: abortCtrl.signal })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body: AnchorsResponse = await res.json()
          if (cancelled) return
          // Replace snapshot — long-poll always returns the full list.
          // `id` is stable, so React reconciliation handles per-anchor
          // re-renders correctly.
          setAnchors(sortByOrder(body.anchors))
          version = body.version
          backoffMs = 1000 // reset on success
        } catch (err: any) {
          if (cancelled) return
          if (err?.name === 'AbortError') return
          // Network blip / 5xx / parse error → backoff and retry.
          await new Promise((r) => setTimeout(r, backoffMs))
          backoffMs = Math.min(30_000, backoffMs * 2)
        }
      }
    }

    void loop()
    return () => {
      cancelled = true
      try { abortCtrl.abort() } catch { /* ignore */ }
    }
  }, [baseUrl, sessionId])

  return anchors
}

/**
 * Imperatively dispatch an action to an anchor. Returns true on success
 * (handler invoked), false if the anchor doesn't exist (already cleared
 * by another call). Network errors propagate.
 */
export async function dispatchAnchorAction(
  baseUrl: string,
  sessionId: string,
  anchorId: string,
  payload: unknown,
): Promise<boolean> {
  const res = await fetch(`${baseUrl}/chat/anchor-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, id: anchorId, payload }),
  })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`anchor action failed: HTTP ${res.status}`)
  return true
}

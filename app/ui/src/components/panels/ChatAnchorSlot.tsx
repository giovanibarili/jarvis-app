// app/ui/src/components/panels/ChatAnchorSlot.tsx
//
// Renders all anchors registered for `sessionId`, stacked vertically with
// highest priority on top. Lives between the chat scroll area and the
// composer, so anchors stay visible regardless of scroll position.
//
// Renderer dispatch:
//   - rendererKind === "choice"  → built-in ChoiceCard from ChatTimeline
//   - renderer.{plugin,file}     → loaded via /plugins/<plugin>/renderers/<file>.js
//                                  (same loader used for HUD pieces)
//   - otherwise                  → fallback diagnostic block
//
// IMPORTANT: This component is session-scoped. Multiple ChatPanel instances
// (e.g. main + actor side-panel) each render their OWN slot with their OWN
// sessionId — anchors never bleed across.

import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import { useAnchors, chatAnchorRegistry, type ChatAnchor } from '../../hooks/useChatAnchors'
import { ChoiceCard, type ChatEntry, type ChoiceAnswer } from './ChatTimeline'

interface Props {
  sessionId: string
  /** Forwarded from ChatPanel for the assistant label on built-in renderers. */
  assistantLabel: string
  assistantLabelColor: string
  /** Same submit handler used by inline ChoiceCard. ChatPanel owns the state
   *  and calls registry.remove() once the answer is committed. */
  onChoiceSubmit?: (anchorId: string, answers: ChoiceAnswer[]) => void
  /** Dismiss handler — host sends a `(dismissed)` signal to the AI and removes
   *  the anchor. Only choice anchors expose a Dismiss button. */
  onChoiceDismiss?: (anchorId: string) => void
}

// ── Plugin renderer cache (one Module per plugin/file pair) ─────────────────

type PluginModule = { default?: ComponentType<any> } & Record<string, any>
const pluginCache = new Map<string, Promise<PluginModule>>()

function loadPluginRenderer(plugin: string, file: string): Promise<PluginModule> {
  const key = `${plugin}::${file}`
  let p = pluginCache.get(key)
  if (!p) {
    const url = `/plugins/${encodeURIComponent(plugin)}/renderers/${encodeURIComponent(file)}.js`
    p = import(/* @vite-ignore */ url).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[anchor] failed to load plugin renderer', { plugin, file, err })
      pluginCache.delete(key)
      throw err
    })
    pluginCache.set(key, p)
  }
  return p
}

function PluginAnchorRenderer({ anchor }: { anchor: ChatAnchor }) {
  const [Comp, setComp] = useState<ComponentType<any> | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!anchor.renderer) return
    let cancelled = false
    loadPluginRenderer(anchor.renderer.plugin, anchor.renderer.file)
      .then((mod) => {
        if (cancelled) return
        const comp = mod.default ?? null
        if (!comp) setErr('plugin renderer has no default export')
        else setComp(() => comp)
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message ?? e))
      })
    return () => {
      cancelled = true
    }
  }, [anchor.renderer?.plugin, anchor.renderer?.file])

  if (err) {
    return (
      <div style={anchorErrorStyle}>
        anchor renderer error ({anchor.renderer?.plugin}/{anchor.renderer?.file}): {err}
      </div>
    )
  }
  if (!Comp) {
    return <div style={anchorPendingStyle}>loading anchor renderer…</div>
  }
  return <Comp anchor={anchor} payload={anchor.payload} />
}

// ── Built-in choice renderer adapter ────────────────────────────────────────

interface ChoiceAnchorPayload {
  choice_id: string
  questions: Array<{
    question: string
    options: Array<{ value: string; label: string; description?: string }>
    multi: boolean
    allow_other: boolean
  }>
}

function ChoiceAnchorRenderer({
  anchor,
  assistantLabel,
  assistantLabelColor,
  onChoiceSubmit,
  onChoiceDismiss,
}: {
  anchor: ChatAnchor
  assistantLabel: string
  assistantLabelColor: string
  onChoiceSubmit?: (anchorId: string, answers: ChoiceAnswer[]) => void
  onChoiceDismiss?: (anchorId: string) => void
}) {
  const payload = anchor.payload as ChoiceAnchorPayload | undefined
  if (!payload || !Array.isArray(payload.questions) || payload.questions.length === 0) {
    return <div style={anchorErrorStyle}>choice anchor: invalid payload</div>
  }
  // Synthesize a ChatEntry-shaped object so we can reuse ChoiceCard verbatim.
  const fakeEntry = {
    kind: 'choice' as const,
    choice_id: payload.choice_id,
    questions: payload.questions,
  } as Extract<ChatEntry, { kind: 'choice' }>

  return (
    <ChoiceCard
      index={0}
      entry={fakeEntry}
      assistantLabel={assistantLabel}
      assistantLabelColor={assistantLabelColor}
      onSubmit={(_idx, answers) => {
        // Delegate to the panel — it owns history/state, then calls
        // chatAnchorRegistry.remove() once the answer is dispatched.
        onChoiceSubmit?.(anchor.id, answers)
      }}
      // Only forward dismiss when the host wants live cards to be cancellable.
      // Inline (historical) ChoiceCards never receive a dismiss handler.
      onDismiss={onChoiceDismiss ? () => onChoiceDismiss(anchor.id) : undefined}
    />
  )
}

// ── Slot ────────────────────────────────────────────────────────────────────

const slotContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '6px 0',
  // Slot is a flex item; never grow past its content. Composer stays anchored.
  flex: '0 0 auto',
}

const anchorPendingStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: '11px',
  color: '#888',
  fontStyle: 'italic',
}

const anchorErrorStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: '11px',
  color: '#ff6b6b',
  background: '#2a1620',
  borderLeft: '3px solid #ff6b6b',
  borderRadius: '4px',
}

export function ChatAnchorSlot({
  sessionId,
  assistantLabel,
  assistantLabelColor,
  onChoiceSubmit,
  onChoiceDismiss,
}: Props) {
  const anchors = useAnchors(sessionId)
  if (anchors.length === 0) return null

  return (
    <div className="chatAnchorSlot" style={slotContainerStyle}>
      {anchors.map((anchor) => {
        // Built-in: choice
        if (anchor.rendererKind === 'choice' && !anchor.renderer) {
          return (
            <ChoiceAnchorRenderer
              key={`${anchor.sessionId}::${anchor.id}`}
              anchor={anchor}
              assistantLabel={assistantLabel}
              assistantLabelColor={assistantLabelColor}
              onChoiceSubmit={onChoiceSubmit}
              onChoiceDismiss={onChoiceDismiss}
            />
          )
        }
        // Plugin renderer
        if (anchor.renderer?.plugin && anchor.renderer.file) {
          return <PluginAnchorRenderer key={`${anchor.sessionId}::${anchor.id}`} anchor={anchor} />
        }
        // Fallback diagnostic — visible misconfiguration
        return (
          <div key={`${anchor.sessionId}::${anchor.id}`} style={anchorErrorStyle}>
            anchor "{anchor.id}" from "{anchor.source}": unknown rendererKind "{anchor.rendererKind}" and no renderer.{'{plugin,file}'} provided
          </div>
        )
      })}
    </div>
  )
}

// Re-export so non-React consumers can imperatively manage anchors
export { chatAnchorRegistry }

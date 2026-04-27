// app/ui/src/components/panels/AnchorSlot.tsx
//
// Renders the chat anchor zone — the slot directly above the chat input
// where Pieces (core or plugin) plant UI elements that must remain
// visible across AI turns. Anchors never scroll with the timeline.
//
// Each anchor's `renderer` field decides how it's rendered:
//   - { builtin: 'choice-card' } → ChoiceCard (core, shipped with HUD)
//   - { plugin, file }            → lazy-loaded React component bundled
//                                   at /plugins/<plugin>/renderers/<file>.js
//
// Plugin renderers receive `{ anchor, onAction }` as props. `onAction`
// posts the payload back to the registry which forwards it to the
// owning Piece's onAction handler in the backend.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChoiceCard } from './ChatTimeline'
import type { ChoiceAnswer, ChoiceQuestion, ChatEntry } from './ChatTimeline'
import type { ChatAnchorEntry } from '../../hooks/useChatAnchors'
import { dispatchAnchorAction } from '../../hooks/useChatAnchors'

interface AnchorSlotProps {
  baseUrl: string
  sessionId: string
  anchors: ChatAnchorEntry[]
  /** Label shown by builtin choice card (e.g. "JARVIS"). */
  assistantLabel: string
  assistantLabelColor: string
}

export function AnchorSlot({
  baseUrl,
  sessionId,
  anchors,
  assistantLabel,
  assistantLabelColor,
}: AnchorSlotProps) {
  if (anchors.length === 0) return null
  return (
    <div className="chatAnchorSlot" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {anchors.map((a) => (
        <AnchorRenderer
          key={a.id}
          baseUrl={baseUrl}
          sessionId={sessionId}
          anchor={a}
          assistantLabel={assistantLabel}
          assistantLabelColor={assistantLabelColor}
        />
      ))}
    </div>
  )
}

interface AnchorRendererProps {
  baseUrl: string
  sessionId: string
  anchor: ChatAnchorEntry
  assistantLabel: string
  assistantLabelColor: string
}

function AnchorRenderer({
  baseUrl,
  sessionId,
  anchor,
  assistantLabel,
  assistantLabelColor,
}: AnchorRendererProps) {
  const post = useMemo(
    () => (payload: unknown) => dispatchAnchorAction(baseUrl, sessionId, anchor.id, payload).catch(() => {}),
    [baseUrl, sessionId, anchor.id],
  )

  // ─── Built-in: choice-card ────────────────────────────────────────────
  if (anchor.renderer.builtin === 'choice-card') {
    return (
      <ChoiceCardAnchor
        anchor={anchor}
        onAction={post}
        assistantLabel={assistantLabel}
        assistantLabelColor={assistantLabelColor}
      />
    )
  }

  // ─── Plugin renderer ──────────────────────────────────────────────────
  if (anchor.renderer.plugin && anchor.renderer.file) {
    return (
      <PluginAnchor
        plugin={anchor.renderer.plugin}
        file={anchor.renderer.file}
        anchor={anchor}
        onAction={post}
      />
    )
  }

  // ─── Unknown renderer — surface a debug stub so the slot doesn't go silent
  return (
    <div style={{
      padding: '8px 12px',
      border: '1px dashed rgba(255, 100, 100, 0.4)',
      borderRadius: '6px',
      color: 'rgba(255, 150, 150, 0.8)',
      fontFamily: 'var(--font-display)',
      fontSize: '11px',
    }}>
      [anchor: unknown renderer · source={anchor.source}]
    </div>
  )
}

// ─── Built-in choice-card anchor ─────────────────────────────────────────

interface ChoiceCardAnchorProps {
  anchor: ChatAnchorEntry
  onAction: (payload: unknown) => void
  assistantLabel: string
  assistantLabelColor: string
}

function ChoiceCardAnchor({ anchor, onAction, assistantLabel, assistantLabelColor }: ChoiceCardAnchorProps) {
  // Adapt the anchor.data into the ChatEntry shape the existing ChoiceCard
  // component expects. anchor.data was built by ChoicePromptPiece and
  // already contains `choice_id`, `questions`, plus optional legacy
  // single-question fields.
  const entry = useMemo<Extract<ChatEntry, { kind: 'choice' }>>(() => {
    const d = anchor.data as {
      choice_id: string
      questions?: ChoiceQuestion[]
      question?: string
      options?: ChoiceQuestion['options']
      multi?: boolean
      allow_other?: boolean
    }
    // ChoiceCard's getQuestions() falls back to the legacy single-question
    // fields if `questions` is missing, so we always populate at least one
    // of the two shapes. We default to an empty array (rather than
    // undefined) to keep the discriminated union happy.
    const questions: ChoiceQuestion[] = Array.isArray(d.questions) ? d.questions : []
    return {
      kind: 'choice',
      choice_id: d.choice_id,
      questions,
      question: d.question,
      options: d.options,
      multi: d.multi,
      allow_other: d.allow_other,
    }
  }, [anchor.data])

  // Resolve the questions list once — used by both submit and ignore paths.
  const questions: ChoiceQuestion[] = useMemo(() => {
    if (Array.isArray(entry.questions) && entry.questions.length > 0) return entry.questions
    if (entry.question && Array.isArray(entry.options)) {
      return [{
        question: entry.question,
        options: entry.options,
        multi: !!entry.multi,
        allow_other: entry.allow_other !== false,
      }]
    }
    return []
  }, [entry])

  const handleSubmit = (_index: number, answers: ChoiceAnswer[]) => {
    // Replicate the legacy ChatPanel.handleChoiceSubmit serialization so
    // the LLM sees the exact same prompt format. We rebuild it here from
    // the entry's questions and the answers.
    if (questions.length === 0) return

    const lineFor = (qi: number): string => {
      const q = questions[qi]
      const a = answers[qi]
      if (!q || !a) return ''
      const labels = a.values.map((v) => {
        if (v === '__other__') return a.otherText ?? '(other)'
        return q.options.find((o) => o.value === v)?.label ?? v
      })
      const joined = q.multi ? labels.join(', ') : (labels[0] ?? '')
      return `${q.question} → ${joined}`
    }

    const prompt = questions.length === 1
      ? `[choice] ${lineFor(0)}`
      : `[choice]\n${questions.map((_, i) => lineFor(i)).filter(Boolean).join('\n')}`

    onAction({ prompt, answers })
  }

  // Ignore path — user dismisses the card without picking an option. The
  // assistant receives `[choice] <question> → closed` (single) or
  // `[choice]\n<q1> → closed\n<q2> → closed` (multi). Same format as a
  // normal answer so the LLM can pattern-match without special casing.
  const handleIgnore = () => {
    if (questions.length === 0) {
      // No questions to serialize — still notify with a generic marker so
      // the LLM knows the card was dismissed and stops waiting.
      onAction({ prompt: '[choice] closed', ignored: true })
      return
    }
    const lineFor = (qi: number): string => {
      const q = questions[qi]
      if (!q) return ''
      return `${q.question} → closed`
    }
    const prompt = questions.length === 1
      ? `[choice] ${lineFor(0)}`
      : `[choice]\n${questions.map((_, i) => lineFor(i)).filter(Boolean).join('\n')}`
    onAction({ prompt, ignored: true })
  }

  return (
    <ChoiceCard
      index={0}
      entry={entry}
      onSubmit={handleSubmit}
      onIgnore={handleIgnore}
      assistantLabel={assistantLabel}
      assistantLabelColor={assistantLabelColor}
    />
  )
}

// ─── Plugin renderer (lazy-loaded module) ────────────────────────────────

const pluginRendererCache = new Map<string, Promise<{ default: React.ComponentType<any> }>>()

function loadPluginRenderer(plugin: string, file: string): Promise<{ default: React.ComponentType<any> }> {
  const key = `${plugin}/${file}`
  let p = pluginRendererCache.get(key)
  if (!p) {
    // Same convention as plugin HUD renderers. Server bundles per-file
    // with esbuild and injects React into window.__JARVIS_REACT.
    p = import(/* @vite-ignore */ `/plugins/${plugin}/renderers/${file}.js`)
    pluginRendererCache.set(key, p)
  }
  return p
}

interface PluginAnchorProps {
  plugin: string
  file: string
  anchor: ChatAnchorEntry
  onAction: (payload: unknown) => void
}

function PluginAnchor({ plugin, file, anchor, onAction }: PluginAnchorProps) {
  const [Component, setComponent] = useState<React.ComponentType<any> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    loadPluginRenderer(plugin, file)
      .then((mod) => {
        if (!mounted.current) return
        setComponent(() => mod.default)
      })
      .catch((err) => {
        if (!mounted.current) return
        setError(err?.message ?? String(err))
      })
    return () => { mounted.current = false }
  }, [plugin, file])

  if (error) {
    return (
      <div style={{
        padding: '8px 12px',
        border: '1px dashed rgba(255, 100, 100, 0.4)',
        borderRadius: '6px',
        color: 'rgba(255, 150, 150, 0.8)',
        fontFamily: 'var(--font-display)',
        fontSize: '11px',
      }}>
        [anchor renderer error: {plugin}/{file} — {error}]
      </div>
    )
  }
  if (!Component) {
    return (
      <div style={{
        padding: '8px 12px',
        opacity: 0.5,
        fontStyle: 'italic',
        fontSize: '11px',
        fontFamily: 'var(--font-display)',
      }}>
        loading anchor renderer…
      </div>
    )
  }
  return <Component anchor={anchor} onAction={onAction} />
}

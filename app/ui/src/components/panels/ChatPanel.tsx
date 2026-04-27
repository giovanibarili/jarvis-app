import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent, type ChangeEvent, type ClipboardEvent } from 'react'
import { ChatTimeline, type ChatEntry } from './ChatTimeline'
import { AnchorSlot } from './AnchorSlot'
import { useChatAnchors } from '../../hooks/useChatAnchors'
import { SlashMenu } from './SlashMenu'

interface PendingImage {
  label: string
  base64: string
  mediaType: string
  thumbnail: string
}

interface ChatPanelFeatures {
  slashMenu?: boolean
  images?: boolean
  abort?: boolean
  compaction?: boolean
}

/**
 * ChatPanel — session-scoped chat UI.
 *
 * Receives a sessionId as the single identity for the conversation. Derives
 * all HTTP endpoints from it. Core/plugins differ only in how they compose a
 * sessionId (e.g. "main" for the root chat, "actor-<name>" for per-actor
 * chats) — this component does not know or care about the naming scheme.
 */
interface ChatPanelProps {
  sessionId: string
  assistantLabel: string
  features?: ChatPanelFeatures
  userLabel?: (source?: string) => string
  userLabelColor?: (source?: string) => string
}

let imageCounter = 0

const defaultFeatures: ChatPanelFeatures = {
  slashMenu: true,
  images: true,
  abort: true,
  compaction: true,
}

const defaultUserLabel = (source?: string) => {
  if (!source || source === 'chat' || source === 'you') return 'YOU'
  if (source === 'jarvis') return 'JARVIS'
  if (source === 'grpc') return 'GRPC'
  return source.toUpperCase()
}

const defaultUserLabelColor = (source?: string) => {
  if (!source || source === 'chat' || source === 'you') return 'var(--chat-user-label)'
  if (source === 'system') return '#fa4'
  if (source === 'jarvis') return '#4af'
  if (source === 'grpc') return '#fa4'
  return '#4af'
}

export function ChatPanel({
  sessionId,
  assistantLabel,
  features: featuresProp,
  userLabel: userLabelProp,
  userLabelColor: userLabelColorProp,
}: ChatPanelProps) {
  if (!sessionId) {
    throw new Error('ChatPanel requires a non-empty sessionId prop')
  }

  // All endpoints are derived from sessionId — a single source of identity.
  const streamUrl = `/chat-stream?sessionId=${encodeURIComponent(sessionId)}`
  const historyUrl = `/chat/history?sessionId=${encodeURIComponent(sessionId)}`
  const sendUrl = `/chat/send`
  const abortUrl = `/chat/abort`
  const clearUrl = `/chat/clear-session`
  const compactUrl = `/chat/compact`

  const features = useMemo(() => ({ ...defaultFeatures, ...featuresProp }), [featuresProp])
  const getUserLabel = useMemo(() => userLabelProp ?? defaultUserLabel, [userLabelProp])
  const getUserLabelColor = useMemo(() => userLabelColorProp ?? defaultUserLabelColor, [userLabelColorProp])

  // Anchor zone — sticky UI elements above the input. Long-poll keeps it
  // in sync with the backend ChatAnchorRegistry.
  const anchors = useChatAnchors('', sessionId)

  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [input, setInput] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [slashActive, setSlashActive] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [panelFocused, setPanelFocused] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const toolStartTimes = useRef(new Map<string, number>())

  // Pending choice cards — buffered while a turn is still streaming, so the
  // card always lands at the END of the assistant turn instead of being
  // injected mid-stream. Flushed on `done`/`error`/`aborted` or when the
  // turn settles (no streaming text and no running capability).
  const pendingChoices = useRef<Array<Extract<ChatEntry, { kind: 'choice' }>>>([])

  // Queued user messages — sent by the user while the session was busy,
  // mirrored from the backend's pendingPrompts queue via SSE `pending_queue`.
  // They render as faint cards under the JARVIS thinking indicator until the
  // backend drains them and they materialize as real user messages.
  const [pendingQueue, setPendingQueue] = useState<Array<{ text: string; source?: string; hasImages?: boolean }>>([])

  // Retry banner state. Set on `retry` SSE, cleared on the next `delta` /
  // `done` / `error` / `aborted` (the AI's next attempt either succeeds or
  // surfaces a terminal event). `deadline` is computed once and used by
  // the renderer to display the live countdown.
  const [retryBanner, setRetryBanner] = useState<
    | { attempt: number; maxAttempts: number; reason: string; deadline: number }
    | null
  >(null)

  // Mirror of streaming/thinking state read inside the SSE callback — that
  // useEffect closes over initial values, so reading state directly there
  // would be stale. Refs stay current.
  const isStreamingRef = useRef(false)
  const isThinkingRef = useRef(false)

  /** Append all buffered choice cards to entries. Safe to call multiple times. */
  const flushPendingChoices = useCallback(() => {
    if (pendingChoices.current.length === 0) return
    const toAppend = pendingChoices.current
    pendingChoices.current = []
    setEntries(prev => [...prev, ...toAppend])
  }, [])

  // Reset conversation state when sessionId changes (panels reused across sessions)
  useEffect(() => {
    setEntries([])
    setStreamingText('')
    setIsStreaming(false)
    setIsThinking(false)
    toolStartTimes.current.clear()
    pendingChoices.current = []
    setPendingQueue([])
    setRetryBanner(null)
  }, [sessionId])

  // Keep refs in sync so the SSE callback below can read the live values.
  useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])
  useEffect(() => { isThinkingRef.current = isThinking }, [isThinking])

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const scrollH = el.scrollHeight
    el.style.height = `${scrollH}px`
    const maxH = window.innerHeight * 0.3
    el.style.overflowY = scrollH > maxH ? 'auto' : 'hidden'
  }, [])

  useEffect(() => { autoResize() }, [input, autoResize])

  useEffect(() => {
    if (features.slashMenu && input.startsWith('/')) {
      setSlashActive(true)
      setSlashQuery(input.slice(1))
    } else {
      setSlashActive(false)
      setSlashQuery('')
    }
  }, [input, features.slashMenu])

  // Hydrate from session history for reconnect/detach
  useEffect(() => {
    fetch(historyUrl)
      .then(r => r.json())
      .then((history: ChatEntry[] | Array<{ role: string; text: string; source?: string }>) => {
        if (!history || history.length === 0) return
        if ('kind' in history[0]) {
          setEntries(history as ChatEntry[])
        } else {
          setEntries((history as Array<{ role: string; text: string; source?: string }>).map(m => ({
            kind: 'message' as const,
            role: m.role === 'user' ? 'user' as const : 'assistant' as const,
            text: m.text,
            source: m.source,
          })))
        }
      })
      .catch(() => {})
  }, [historyUrl])

  // SSE stream scoped to this sessionId
  useEffect(() => {
    const source = new EventSource(streamUrl)

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)

      switch (data.type) {
        case 'user':
          setEntries(prev => [...prev, { kind: 'message', role: 'user', text: data.text, images: data.images, source: data.source, session: data.session }])
          setIsThinking(true)
          break
        case 'delta':
          setIsThinking(false)
          setIsStreaming(true)
          setStreamingText(prev => prev + data.text)
          // First successful chunk after a retry → clear the banner
          setRetryBanner(null)
          break
        case 'done':
          setIsStreaming(false)
          setIsThinking(false)
          setRetryBanner(null)
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session }])
            }
            return ''
          })
          // Turn finished — choice cards captured during the turn now land
          // at the very end of the conversation, AFTER any final assistant text.
          flushPendingChoices()
          break
        case 'error':
          setIsStreaming(false)
          setIsThinking(false)
          setRetryBanner(null)
          setEntries(prev => [...prev, { kind: 'message', role: 'assistant', text: `[Error: ${data.error}]`, source: data.source }])
          setStreamingText('')
          // Even on error, surface the buffered cards so the user isn't blocked.
          flushPendingChoices()
          break
        case 'tool_start':
          // Skip jarvis_ask_choice — the choice card (kind:'choice') replaces
          // the default capability entry for this tool.
          if (data.name === 'jarvis_ask_choice') break
          setStreamingText(prev => {
            if (prev) {
              setIsStreaming(false)
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session }])
            }
            return ''
          })
          toolStartTimes.current.set(data.id, Date.now())
          setEntries(prev => [...prev, { kind: 'capability', name: data.name, id: data.id, args: data.args, status: 'running' }])
          setIsThinking(true)
          break
        case 'tool_done': {
          if (data.name === 'jarvis_ask_choice') break
          const startTime = toolStartTimes.current.get(data.id)
          const ms = startTime ? Date.now() - startTime : undefined
          toolStartTimes.current.delete(data.id)
          setEntries(prev => prev.map(e =>
            e.kind === 'capability' && e.id === data.id ? { ...e, status: 'done' as const, ms, output: data.output } : e
          ))
          setEntries(prev => {
            const hasRunning = prev.some(e => e.kind === 'capability' && e.status === 'running')
            if (!hasRunning) setIsThinking(true)
            return prev
          })
          break
        }
        case 'tool_cancelled':
          if (data.name === 'jarvis_ask_choice') break
          toolStartTimes.current.delete(data.id)
          setEntries(prev => prev.map(e =>
            e.kind === 'capability' && e.id === data.id ? { ...e, status: 'cancelled' as const } : e
          ))
          break
        case 'aborted':
          setIsStreaming(false)
          setIsThinking(false)
          setRetryBanner(null)
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session, aborted: true }])
            }
            return ''
          })
          flushPendingChoices()
          break
        case 'retry': {
          // AI session hit a transient error (529/503/429/network) and is
          // sleeping before retrying. Show a banner with the current
          // attempt and a live countdown until the retry fires. Cleared
          // on the next delta / done / error / aborted.
          const r = data.retry as { attempt: number; maxAttempts: number; delayMs: number; reason: string } | undefined
          if (r) {
            setRetryBanner({
              attempt: r.attempt,
              maxAttempts: r.maxAttempts,
              reason: r.reason,
              deadline: Date.now() + r.delayMs,
            })
            // While sleeping the actor is neither streaming nor thinking
            // (the call hasn't restarted yet). Keep `isThinking` true so
            // the user sees something animated; the banner sits next to it.
            setIsThinking(true)
          }
          break
        }
        case 'compaction':
          if (!features.compaction) break
          setIsThinking(false)
          setIsStreaming(false)
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session }])
            }
            return ''
          })
          setEntries(prev => [...prev, {
            kind: 'compaction',
            engine: data.engine ?? 'api',
            tokensBefore: data.tokensBefore ?? 0,
            tokensAfter: data.tokensAfter ?? 0,
            summary: data.summary ?? '',
          }])
          break
        case 'session_cleared':
          setEntries([])
          setStreamingText('')
          setIsStreaming(false)
          setIsThinking(false)
          // Drop any buffered cards — they belonged to the wiped session.
          pendingChoices.current = []
          setPendingQueue([])
          setRetryBanner(null)
          break
        case 'pending_queue':
          // Backend snapshot of the user-message queue for this session.
          // Empty array clears the UI list (drained or aborted).
          setPendingQueue(Array.isArray(data.items) ? data.items : [])
          break
        case 'choice': {
          // LEGACY PATH — no longer used by ChoicePromptPiece (which now
          // plants an anchor via ChatAnchorRegistry, picked up by the
          // useChatAnchors long-poll above). Kept only as a safety net
          // for environments where the anchor registry isn't wired
          // (older builds or embedded headless usage).
          //
          // We push directly into the timeline so the user can still
          // answer the question. Reload via /chat/history will continue
          // to reconstruct historical choice cards from tool_use blocks
          // — that path is unaffected by this change.
          const questions = Array.isArray(data.questions) && data.questions.length > 0
            ? data.questions.map((q: any) => ({
                question: String(q.question ?? ''),
                options: Array.isArray(q.options) ? q.options : [],
                multi: !!q.multi,
                allow_other: q.allow_other !== false,
              }))
            : [{
                question: String(data.question ?? ''),
                options: Array.isArray(data.options) ? data.options : [],
                multi: !!data.multi,
                allow_other: data.allow_other !== false,
              }]

          const card: Extract<ChatEntry, { kind: 'choice' }> = {
            kind: 'choice',
            choice_id: data.choice_id,
            questions,
          }
          pendingChoices.current.push(card)
          if (!isStreamingRef.current && !isThinkingRef.current) {
            flushPendingChoices()
          }
          break
        }
      }
    }

    return () => source.close()
  }, [streamUrl, features.compaction, flushPendingChoices])

  // Track focus on this chat panel
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onFocusIn = () => setPanelFocused(true)
    const onFocusOut = (e: FocusEvent) => {
      if (!panel.contains(e.relatedTarget as Node)) setPanelFocused(false)
    }
    panel.addEventListener('focusin', onFocusIn)
    panel.addEventListener('focusout', onFocusOut)
    return () => {
      panel.removeEventListener('focusin', onFocusIn)
      panel.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  // Esc to abort — only when THIS panel has focus
  useEffect(() => {
    if (!features.abort) return
    const handleEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && panelFocused && !slashActive && (isStreaming || isThinking)) {
        e.preventDefault()
        fetch(abortUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {})
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [features.abort, abortUrl, sessionId, isStreaming, isThinking, slashActive, panelFocused])

  const send = (overrideText?: string) => {
    const prompt = (overrideText ?? input).trim()
    if (!prompt && images.length === 0) return

    const text = prompt || (images.length > 0 ? images.map(i => i.label).join(', ') : '')
    const payload: Record<string, unknown> = {
      sessionId,
      prompt: text,
      ...(features.images && images.length > 0
        ? { images: images.map(({ label, base64, mediaType }) => ({ label, base64, mediaType })) }
        : {}),
    }

    setInput('')
    setImages([])
    setSlashActive(false)
    fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
    textareaRef.current?.focus()
  }

  const handleSlashSelect = useCallback((name: string) => {
    setSlashActive(false)
    setSlashQuery('')
    setInput('')

    if (name === 'clear_session') {
      fetch(clearUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {})
      textareaRef.current?.focus()
      return
    }
    if (name === 'compact') {
      fetch(compactUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {})
      textareaRef.current?.focus()
      return
    }

    send(`use /${name}`)
  }, [sessionId, clearUrl, compactUrl, images])

  const handleSlashClose = useCallback(() => {
    setSlashActive(false)
    setInput('')
  }, [])

  const handleKey = (e: KeyboardEvent) => {
    if (slashActive && ['ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(e.key)) return
    if (slashActive && e.key === 'Enter' && !e.shiftKey) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }

  const handlePaste = (e: ClipboardEvent) => {
    if (!features.images) return
    const items = e.clipboardData?.items
    if (!items) return

    const hasText = Array.from(items).some(i => i.type === 'text/plain')
    const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'))

    if (imageItems.length === 0 || hasText) return

    e.preventDefault()
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const [header, base64] = dataUrl.split(',')
        const mediaType = header.split(':')[1].split(';')[0]
        imageCounter++
        const label = `Image #${imageCounter}`
        setImages(prev => [...prev, { label, base64, mediaType, thumbnail: dataUrl }])
      }
      reader.readAsDataURL(file)
    }
  }

  const removeImage = (label: string) => {
    setImages(prev => prev.filter(i => i.label !== label))
  }

  const handleChoiceSubmit = useCallback((index: number, answers: { values: string[]; otherText?: string }[]) => {
    // Build prompt from captured questions+answers BEFORE mutating state
    let questionsSnapshot: Array<{ question: string; options: { value: string; label: string }[]; multi: boolean }> = []

    setEntries(prev => {
      const target = prev[index]
      if (!target || target.kind !== 'choice') return prev
      // Snapshot questions (prefer new shape, fall back to legacy fields)
      if (Array.isArray(target.questions) && target.questions.length > 0) {
        questionsSnapshot = target.questions.map(q => ({
          question: q.question,
          options: q.options,
          multi: q.multi,
        }))
      } else if (target.question) {
        questionsSnapshot = [{
          question: target.question,
          options: target.options ?? [],
          multi: !!target.multi,
        }]
      }
      return prev.map((e, i) => {
        if (i !== index) return e
        if (e.kind !== 'choice') return e
        return { ...e, answers }
      })
    })

    if (questionsSnapshot.length === 0) return

    // Serialize: "[choice] q → answer" (single) or "[choice]\nq1 → a1\nq2 → a2" (multi)
    const lineFor = (qi: number): string => {
      const q = questionsSnapshot[qi]
      const a = answers[qi]
      if (!q || !a) return ''
      const labels = a.values.map(v => {
        if (v === '__other__') return a.otherText ?? '(other)'
        return q.options.find(o => o.value === v)?.label ?? v
      })
      const joined = q.multi ? labels.join(', ') : (labels[0] ?? '')
      return `${q.question} → ${joined}`
    }

    const prompt = questionsSnapshot.length === 1
      ? `[choice] ${lineFor(0)}`
      : `[choice]\n${questionsSnapshot.map((_, i) => lineFor(i)).filter(Boolean).join('\n')}`

    fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt }),
    }).catch(() => {})
  }, [sendUrl, sessionId])

  const toggleExpand = useCallback((index: number) => {
    setEntries(prev => prev.map((e, j) => {
      if (j !== index) return e
      if (e.kind === 'capability') return { ...e, expanded: !e.expanded }
      if (e.kind === 'compaction') return { ...e, expanded: !e.expanded }
      return e
    }))
  }, [])

  return (
    <div className="chatDocked" ref={panelRef}>
      <div className="chatDockedOutput" onMouseDown={e => e.stopPropagation()}>
        <ChatTimeline
          entries={entries}
          streamingText={streamingText}
          isStreaming={isStreaming}
          isThinking={isThinking}
          assistantLabel={assistantLabel}
          userLabel={getUserLabel}
          userLabelColor={getUserLabelColor}
          onToggleExpand={toggleExpand}
          onChoiceSubmit={handleChoiceSubmit}
          pendingQueue={pendingQueue}
          retryBanner={retryBanner}
        />
      </div>

      {/*
        Anchor zone — a fixed slot between the scrolling timeline and the
        input. Pieces (core or plugin) plant UI here that must remain
        visible across AI turns. Currently consumed by ChoicePromptPiece
        for sticky choice cards. Scroll-locked: when the timeline grows,
        anchors stay put.
      */}
      <div
        className="chatAnchors"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ padding: anchors.length > 0 ? '6px 12px 0 12px' : 0 }}
      >
        <AnchorSlot
          baseUrl=""
          sessionId={sessionId}
          anchors={anchors}
          assistantLabel={assistantLabel}
          assistantLabelColor="var(--chat-jarvis-label)"
        />
      </div>

      <div className="chatDockedInput">
        <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {features.slashMenu && (
            <SlashMenu
              query={slashQuery}
              onSelect={handleSlashSelect}
              onClose={handleSlashClose}
              visible={slashActive}
            />
          )}
          {features.images && images.length > 0 && (
            <div className="chatImagePreview">
              {images.map(img => (
                <div key={img.label} className="chatImageThumb">
                  <img src={img.thumbnail} alt={img.label} />
                  <span className="chatImageLabel">{img.label}</span>
                  <button className="chatImageRemove" onClick={() => removeImage(img.label)}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="chatInputBar" style={{ alignItems: 'flex-end' }}>
            <span className="chatInputLabel" style={{ paddingBottom: '3px' }}>YOU</span>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKey}
              onPaste={handlePaste}
              placeholder={features.slashMenu ? 'Type a message... (/ for commands)' : 'Type a message...'}
              autoFocus
              rows={1}
              className="chatInput chatTextarea"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

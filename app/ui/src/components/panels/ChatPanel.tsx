import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent, type ChangeEvent, type ClipboardEvent } from 'react'
import { ChatTimeline, type ChatEntry } from './ChatTimeline'
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

interface ChatPanelProps {
  streamUrl: string
  sendUrl: string
  abortUrl?: string
  historyUrl?: string
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
  if (!source || source === 'chat') return 'YOU'
  if (source === 'jarvis') return 'JARVIS'
  if (source === 'grpc') return 'GRPC'
  return source.toUpperCase()
}

const defaultUserLabelColor = (source?: string) => {
  if (!source || source === 'chat') return 'var(--chat-user-label)'
  if (source === 'system') return '#fa4'
  if (source === 'jarvis') return '#4af'
  if (source === 'grpc') return '#fa4'
  return '#4af'
}

export function ChatPanel({
  streamUrl,
  sendUrl,
  abortUrl,
  historyUrl,
  assistantLabel,
  features: featuresProp,
  userLabel: userLabelProp,
  userLabelColor: userLabelColorProp,
}: ChatPanelProps) {
  const features = useMemo(() => ({ ...defaultFeatures, ...featuresProp }), [featuresProp])
  const getUserLabel = userLabelProp ?? defaultUserLabel
  const getUserLabelColor = userLabelColorProp ?? defaultUserLabelColor

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

  // Track slash state
  useEffect(() => {
    if (features.slashMenu && input.startsWith('/')) {
      setSlashActive(true)
      setSlashQuery(input.slice(1))
    } else {
      setSlashActive(false)
      setSlashQuery('')
    }
  }, [input, features.slashMenu])

  // Load history on mount — hydrate from session messages (for reconnect/detach)
  useEffect(() => {
    const url = historyUrl ?? '/chat/history'
    fetch(url)
      .then(r => r.json())
      .then((history: ChatEntry[] | Array<{ role: string; text: string; source?: string }>) => {
        if (!history || history.length === 0) return
        // Detect format: ChatEntry[] (from /chat/history) vs legacy actor format
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

  // SSE stream
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
          break
        case 'done':
          setIsStreaming(false)
          setIsThinking(false)
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session }])
            }
            return ''
          })
          break
        case 'error':
          setIsStreaming(false)
          setIsThinking(false)
          setEntries(prev => [...prev, { kind: 'message', role: 'assistant', text: `[Error: ${data.error}]`, source: data.source }])
          setStreamingText('')
          break
        case 'tool_start':
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
          toolStartTimes.current.delete(data.id)
          setEntries(prev => prev.map(e =>
            e.kind === 'capability' && e.id === data.id ? { ...e, status: 'cancelled' as const } : e
          ))
          break
        case 'aborted':
          setIsStreaming(false)
          setIsThinking(false)
          setStreamingText(prev => {
            if (prev) {
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, source: data.source, session: data.session, aborted: true }])
            }
            return ''
          })
          break
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
          break
      }
    }

    return () => source.close()
  }, [streamUrl, features.compaction])

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
    if (!features.abort || !abortUrl) return
    const handleEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && panelFocused && !slashActive && (isStreaming || isThinking)) {
        e.preventDefault()
        fetch(abortUrl, { method: 'POST' }).catch(() => {})
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [features.abort, abortUrl, isStreaming, isThinking, slashActive, panelFocused])

  const send = (overrideText?: string) => {
    const prompt = (overrideText ?? input).trim()
    if (!prompt && images.length === 0) return

    const text = prompt || (images.length > 0 ? images.map(i => i.label).join(', ') : '')
    const payload: Record<string, unknown> = features.images
      ? { prompt: text, images: images.length > 0 ? images.map(({ label, base64, mediaType }) => ({ label, base64, mediaType })) : undefined }
      : { text }

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
      fetch('/chat/clear-session', { method: 'POST' }).catch(() => {})
      textareaRef.current?.focus()
      return
    }

    send(`use /${name}`)
  }, [images])

  const handleSlashClose = useCallback(() => {
    setSlashActive(false)
    setInput('')
  }, [])

  const handleKey = (e: KeyboardEvent) => {
    if (slashActive && ['ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(e.key)) {
      return
    }
    if (slashActive && e.key === 'Enter' && !e.shiftKey) {
      return
    }
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
      <div className="chatDockedOutput">
        <ChatTimeline
          entries={entries}
          streamingText={streamingText}
          isStreaming={isStreaming}
          isThinking={isThinking}
          assistantLabel={assistantLabel}
          userLabel={getUserLabel}
          userLabelColor={getUserLabelColor}
          onToggleExpand={toggleExpand}
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
              placeholder={features.slashMenu ? "Type a message... (/ for commands)" : "Talk to actor..."}
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

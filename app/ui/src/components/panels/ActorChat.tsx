import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ChangeEvent } from 'react'
import { ChatTimeline, type ChatEntry } from './ChatTimeline'

const ACTOR_BASE = 'http://localhost:50052/plugins/actors'

export function ActorChat({ actorName }: { actorName: string; onClose?: () => void }) {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const toolStartTimes = useRef(new Map<string, number>())

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

  // Load history
  useEffect(() => {
    fetch(`${ACTOR_BASE}/${actorName}/history`)
      .then(r => r.json())
      .then((history: Array<{ role: string; text: string; source?: string }>) => {
        if (history.length > 0) {
          setEntries(history.map(m => ({
            kind: 'message' as const,
            role: m.role === 'user' ? 'user' as const : 'assistant' as const,
            text: m.text,
            source: m.source,
          })))
        }
      })
      .catch(() => {})
  }, [actorName])

  // SSE stream
  useEffect(() => {
    const source = new EventSource(`${ACTOR_BASE}/${actorName}/stream`)

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)

      switch (data.type) {
        case 'user':
          setEntries(prev => [...prev, { kind: 'message', role: 'user', text: data.text, source: data.source }])
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
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev }])
            }
            return ''
          })
          break
        case 'error':
          setIsStreaming(false)
          setIsThinking(false)
          setEntries(prev => [...prev, { kind: 'message', role: 'assistant', text: `[Error: ${data.error}]` }])
          setStreamingText('')
          break
        case 'tool_start':
          setStreamingText(prev => {
            if (prev) {
              setIsStreaming(false)
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev }])
            }
            return ''
          })
          toolStartTimes.current.set(data.id, Date.now())
          setEntries(prev => [...prev, { kind: 'capability', name: data.name, id: data.id, args: data.args, status: 'running' }])
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
              setEntries(msgs => [...msgs, { kind: 'message', role: 'assistant', text: prev, aborted: true }])
            }
            return ''
          })
          break
      }
    }

    return () => source.close()
  }, [actorName])

  const send = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    fetch(`${ACTOR_BASE}/${actorName}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {})
    textareaRef.current?.focus()
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }

  const toggleExpand = useCallback((index: number) => {
    setEntries(prev => prev.map((e, j) =>
      j === index && e.kind === 'capability' ? { ...e, expanded: !e.expanded } : e
    ))
  }, [])

  const userLabel = (source?: string) => {
    if (source === 'jarvis') return 'JARVIS'
    if (source === 'grpc') return 'GRPC'
    return 'YOU'
  }

  const userLabelColor = (source?: string) => {
    if (source === 'jarvis') return '#4af'
    if (source === 'grpc') return '#fa4'
    return 'var(--chat-user-label)'
  }

  return (
    <div className="chatDocked">
      <div className="chatDockedOutput">
        <ChatTimeline
          entries={entries}
          streamingText={streamingText}
          isStreaming={isStreaming}
          isThinking={isThinking}
          assistantLabel={actorName.toUpperCase()}
          userLabel={userLabel}
          userLabelColor={userLabelColor}
          onToggleExpand={toggleExpand}
        />
      </div>

      <div className="chatDockedInput">
        <div className="chatInputBar" style={{ alignItems: 'flex-end' }}>
          <span className="chatInputLabel" style={{ paddingBottom: '3px' }}>YOU</span>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKey}
            placeholder="Talk to actor..."
            rows={1}
            className="chatInput chatTextarea"
          />
        </div>
      </div>
    </div>
  )
}

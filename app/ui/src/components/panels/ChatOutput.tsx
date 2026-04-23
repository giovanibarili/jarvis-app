import { useState, useRef, useEffect, useCallback } from 'react'
import { ChatTimeline, type ChatEntry } from './ChatTimeline'

export function ChatOutput() {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const toolStartTimes = useRef(new Map<string, number>())

  useEffect(() => {
    const source = new EventSource('/chat-stream')

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
        case 'bash_result':
          setEntries(prev => [...prev, {
            kind: 'bash_result',
            command: data.command,
            output: data.output ?? '',
            exitCode: data.exitCode ?? 0,
            ms: data.ms ?? 0,
          }])
          setIsThinking(false)
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
  }, [])

  const toggleExpand = useCallback((index: number) => {
    setEntries(prev => prev.map((e, j) => {
      if (j !== index) return e
      if (e.kind === 'capability') return { ...e, expanded: !e.expanded }
      if (e.kind === 'compaction') return { ...e, expanded: !e.expanded }
      if (e.kind === 'bash_result') return { ...e, expanded: !e.expanded }
      return e
    }))
  }, [])

  const userLabel = (source?: string) => {
    if (!source || source === 'chat') return 'YOU'
    return source.toUpperCase()
  }

  const userLabelColor = (source?: string) => {
    if (!source || source === 'chat') return 'var(--chat-user-label)'
    if (source === 'system') return '#fa4'
    return '#4af'
  }

  return (
    <ChatTimeline
      entries={entries}
      streamingText={streamingText}
      isStreaming={isStreaming}
      isThinking={isThinking}
      assistantLabel="JARVIS"
      userLabel={userLabel}
      userLabelColor={userLabelColor}
      onToggleExpand={toggleExpand}
    />
  )
}

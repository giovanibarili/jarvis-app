import { useRef, useEffect } from 'react'
import { MarkdownText } from '../MarkdownText'

interface ChatImage {
  label: string
  base64: string
  mediaType: string
}

export type ChatEntry =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; images?: ChatImage[]; source?: string; session?: string; aborted?: boolean }
  | { kind: 'capability'; name: string; id: string; args?: string; status: 'running' | 'done' | 'cancelled'; ms?: number; output?: string; expanded?: boolean }
  | { kind: 'compaction'; engine: 'api' | 'fallback'; tokensBefore: number; tokensAfter: number; summary: string; expanded?: boolean }

interface Props {
  entries: ChatEntry[]
  streamingText: string
  isStreaming: boolean
  isThinking: boolean
  assistantLabel: string
  /** Labels for user messages — maps source to display name */
  userLabel?: (source?: string) => string
  /** Colors for user labels */
  userLabelColor?: (source?: string) => string
  /** Colors for assistant labels */
  assistantLabelColor?: string
  onToggleExpand: (index: number) => void
}

export function ChatTimeline({
  entries,
  streamingText,
  isStreaming,
  isThinking,
  assistantLabel,
  userLabel = () => 'YOU',
  userLabelColor = () => 'var(--chat-user-label)',
  assistantLabelColor = 'var(--chat-jarvis-label)',
  onToggleExpand,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, streamingText])

  const labelFor = (msg: ChatEntry & { kind: 'message' }) => {
    if (msg.role === 'user') return userLabel(msg.source)
    if (msg.source && msg.source !== 'jarvis') return msg.source.toUpperCase()
    return assistantLabel
  }

  const labelColor = (msg: ChatEntry & { kind: 'message' }) => {
    if (msg.role === 'user') return userLabelColor(msg.source)
    if (msg.source && msg.source !== 'jarvis') return '#a6f'
    return assistantLabelColor
  }

  return (
    <div ref={containerRef} style={{ height: '100%', overflowY: 'auto', padding: '8px 12px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
      {entries.map((entry, i) => {
        if (entry.kind === 'message') {
          return (
            <div key={i} style={{
              color: entry.role === 'user' ? 'var(--chat-user)' : 'var(--chat-jarvis)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: '1.5',
              marginBottom: '4px',
            }}>
              <span style={{ color: labelColor(entry), marginRight: '8px', fontFamily: 'var(--font-display)', fontSize: '9px', fontWeight: 600 }}>
                {labelFor(entry)}
              </span>
              {entry.role === 'user' ? (
                <>
                  {entry.text}
                  {entry.images && entry.images.length > 0 && (
                    <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                      {entry.images.map(img => (
                        <div key={img.label} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                          <img
                            src={`data:${img.mediaType};base64,${img.base64}`}
                            alt={img.label}
                            style={{ maxHeight: '120px', maxWidth: '200px', borderRadius: '4px', border: '1px solid var(--panel-border)' }}
                          />
                          <span style={{ fontSize: '8px', color: 'var(--color-muted)' }}>{img.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <MarkdownText text={entry.text} />
              )}
              {entry.aborted && (
                <span style={{ color: '#666', fontStyle: 'italic', marginLeft: '8px', fontSize: '10px' }}>⊘ interrupted</span>
              )}
            </div>
          )
        }

        if (entry.kind === 'capability') {
          let rawOutput = entry.output ?? ''
          try {
            const parsed = JSON.parse(rawOutput)
            rawOutput = parsed.stdout ?? parsed.text ?? parsed.content ?? parsed.path ?? (typeof parsed === 'string' ? parsed : JSON.stringify(parsed))
          } catch { /* not JSON, use as-is */ }
          rawOutput = rawOutput.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          const outputLines = rawOutput.split('\n').filter(Boolean)
          const previewLines = outputLines.slice(-1)
          const hasMore = outputLines.length > 1
          const visibleLines = entry.expanded ? outputLines : previewLines

          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: entry.output ? '4px 4px 0 0' : '4px',
                  fontSize: '10px',
                  borderLeft: entry.status === 'running' ? '3px solid #f1fa8c'
                    : entry.status === 'done' ? '3px solid #50fa7b'
                    : '3px solid #666',
                  background: '#1a1e2e',
                  color: entry.status === 'running' ? '#f1fa8c'
                    : entry.status === 'done' ? '#50fa7b'
                    : '#666',
                  cursor: entry.output ? 'pointer' : 'default',
                }}
                onClick={entry.output ? () => onToggleExpand(i) : undefined}
              >
                {entry.status === 'running' && <span style={{ animation: 'pulse 1.5s infinite', display: 'inline-block' }}>⚡</span>}
                {entry.status === 'done' && '✓'}
                {entry.status === 'cancelled' && '⊘'}
                {' '}<strong>{entry.name}</strong>
                {entry.args && <span style={{ opacity: 0.7, marginLeft: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '60%', verticalAlign: 'bottom' }}>{entry.args}</span>}
                {entry.status === 'done' && entry.ms != null && <span style={{ marginLeft: '4px' }}>{entry.ms}ms</span>}
                {entry.status === 'cancelled' && <span style={{ fontStyle: 'italic' }}> interrupted</span>}
                {hasMore && <span style={{ marginLeft: '4px', opacity: 0.5 }}>{entry.expanded ? '▾' : '▸'}</span>}
              </div>
              {entry.output && visibleLines.length > 0 && (
                <div
                  style={{
                    padding: '2px 8px 2px 14px',
                    background: '#111420',
                    borderLeft: '3px solid #333',
                    borderRadius: '0 0 4px 4px',
                    fontSize: '9px',
                    color: '#888',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: entry.expanded ? 'none' : '16px',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    lineHeight: '1.4',
                  }}
                  onClick={() => onToggleExpand(i)}
                >
                  {visibleLines.join('\n')}
                </div>
              )}
            </div>
          )
        }

        if (entry.kind === 'compaction') {
          const beforeK = Math.round(entry.tokensBefore / 1000)
          const afterK = Math.round(entry.tokensAfter / 1000)
          const badge = entry.engine === 'fallback' ? ' (fallback)' : ''
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              <div
                style={{
                  padding: '3px 8px',
                  borderRadius: entry.expanded ? '4px 4px 0 0' : '4px',
                  fontSize: '10px',
                  borderLeft: '3px solid #8be9fd',
                  background: '#1a1e2e',
                  color: '#8be9fd',
                  cursor: 'pointer',
                }}
                onClick={() => onToggleExpand(i)}
              >
                Context compacted — {beforeK}K → {afterK}K tokens{badge}
                <span style={{ marginLeft: '4px', opacity: 0.5 }}>{entry.expanded ? '▾' : '▸'}</span>
              </div>
              {entry.expanded && (
                <div style={{
                  padding: '4px 8px 4px 14px',
                  background: '#111420',
                  borderLeft: '3px solid #333',
                  borderRadius: '0 0 4px 4px',
                  fontSize: '9px',
                  color: '#888',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '200px',
                  overflowY: 'auto',
                  lineHeight: '1.4',
                }}>
                  {entry.summary}
                </div>
              )}
            </div>
          )
        }

        return null
      })}

      {isThinking && !streamingText && (() => {
        const hasRunning = entries.some(e => e.kind === 'capability' && e.status === 'running')
        return (
          <div style={{ color: '#666', lineHeight: '1.5', marginBottom: '4px' }}>
            <span style={{ color: assistantLabelColor, marginRight: '8px', fontFamily: 'var(--font-display)', fontSize: '9px', fontWeight: 600, opacity: 0.6 }}>{assistantLabel}</span>
            <span style={{ fontStyle: 'italic', animation: 'pulse 1.5s infinite', display: 'inline-block' }}>
              {hasRunning ? 'working...' : 'thinking...'}
            </span>
          </div>
        )
      })()}

      {streamingText && (
        <div style={{ color: 'var(--chat-jarvis)', whiteSpace: 'pre-wrap', lineHeight: '1.5', marginBottom: '4px' }}>
          <span style={{ color: assistantLabelColor, marginRight: '8px', fontFamily: 'var(--font-display)', fontSize: '9px', fontWeight: 600 }}>{assistantLabel}</span>
          <MarkdownText text={streamingText} />
          {isStreaming && <span className="streaming-cursor" />}
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        .streaming-cursor {
          display: inline-block;
          width: 7px;
          height: 12px;
          background: #50fa7b;
          animation: blink 1s infinite;
          vertical-align: middle;
          margin-left: 2px;
        }
      `}</style>
    </div>
  )
}

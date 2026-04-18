import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { HudComponentState } from '../../types/hud'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import Prism from 'prismjs'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-clojure'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-toml'

// ─── Types mirrored from diff-viewer piece ───

interface Annotation {
  line: number
  text: string
  type?: 'info' | 'warning' | 'error'
}

interface DiffEntry {
  path: string
  language: string
  oldContent: string
  newContent: string
  diff: string
  annotations?: Annotation[]
}

interface FileEntry {
  path: string
  language: string
  content: string
  highlightLines?: number[]
  annotations?: Annotation[]
}

interface DiffViewerData {
  mode: 'diff' | 'file' | 'compare'
  viewMode: 'inline' | 'side-by-side'
  activeTab: number
  title?: string
  diffs?: DiffEntry[]
  file?: FileEntry
  historyCount: number
}

/** A tab accumulated in local state — wraps the incoming data */
interface ViewerTab {
  id: string
  title: string
  data: DiffViewerData
  status: 'pending' | 'accepted' | 'rejected'
}

// ─── Send ai.request to the backend ───

function sendAiRequest(text: string) {
  fetch('/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {})
}

// ─── Styles ───

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    background: '#0a0e14',
    color: '#c8d0d8',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: '12px',
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    borderBottom: '1px solid #1a2030',
    background: '#0d1218',
    flexShrink: 0,
    minHeight: '32px',
  },
  title: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#4af',
    letterSpacing: '1px',
    textTransform: 'uppercase' as const,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  toggleBtn: (active: boolean) => ({
    padding: '2px 8px',
    fontSize: '10px',
    border: `1px solid ${active ? '#4af' : '#2a3040'}`,
    borderRadius: '3px',
    background: active ? 'rgba(68,170,255,0.15)' : 'transparent',
    color: active ? '#4af' : '#6a7a8a',
    cursor: 'pointer',
    transition: 'all 0.15s',
  }),
  actionBtn: (variant: 'accept' | 'reject') => {
    const isAccept = variant === 'accept'
    return {
      padding: '3px 12px',
      fontSize: '10px',
      fontWeight: 600,
      border: `1px solid ${isAccept ? '#4c8' : '#f55'}`,
      borderRadius: '3px',
      background: isAccept ? 'rgba(68,200,100,0.15)' : 'rgba(255,80,80,0.15)',
      color: isAccept ? '#8fd8a0' : '#f8a0a0',
      cursor: 'pointer',
      transition: 'all 0.15s',
      letterSpacing: '0.5px',
    }
  },
  tabBar: {
    display: 'flex',
    gap: '0',
    borderBottom: '1px solid #1a2030',
    background: '#0b1018',
    flexShrink: 0,
    overflowX: 'auto' as const,
  },
  tab: (active: boolean, status: string) => {
    const statusColors: Record<string, string> = {
      accepted: '#4c8',
      rejected: '#f55',
      pending: active ? '#4af' : '#6a7a8a',
    }
    const color = statusColors[status] ?? statusColors.pending
    return {
      padding: '4px 8px',
      fontSize: '10px',
      color,
      borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
      cursor: 'pointer',
      background: active ? 'rgba(68,170,255,0.05)' : 'transparent',
      transition: 'all 0.15s',
      whiteSpace: 'nowrap' as const,
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    }
  },
  tabClose: {
    fontSize: '9px',
    color: '#4a5a6a',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '1px 2px',
    borderRadius: '2px',
    transition: 'all 0.15s',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    contain: 'strict' as const,
  },
  fileView: {
    padding: '0',
    overflow: 'auto',
    height: '100%',
  },
  lineNumber: {
    display: 'inline-block',
    width: '45px',
    textAlign: 'right' as const,
    paddingRight: '12px',
    color: '#3a4a5a',
    userSelect: 'none' as const,
    fontSize: '11px',
  },
  codeLine: (highlighted: boolean) => ({
    display: 'block',
    padding: '0 8px 0 0',
    background: highlighted ? 'rgba(68,170,255,0.08)' : 'transparent',
    borderLeft: highlighted ? '3px solid #4af' : '3px solid transparent',
    minHeight: '18px',
    lineHeight: '18px',
  }),
  annotation: (type: string) => {
    const colors: Record<string, { bg: string; border: string; color: string }> = {
      info: { bg: 'rgba(68,170,255,0.1)', border: '#4af', color: '#8cf' },
      warning: { bg: 'rgba(255,170,68,0.1)', border: '#fa4', color: '#fc8' },
      error: { bg: 'rgba(255,68,68,0.1)', border: '#f44', color: '#f88' },
    }
    const c = colors[type] ?? colors.info
    return {
      padding: '2px 8px 2px 60px',
      fontSize: '10px',
      color: c.color,
      background: c.bg,
      borderLeft: `3px solid ${c.border}`,
    }
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#3a4a5a',
    fontSize: '12px',
    fontStyle: 'italic',
  },
  stats: {
    display: 'flex',
    gap: '12px',
    padding: '4px 10px',
    borderTop: '1px solid #1a2030',
    background: '#0b1018',
    fontSize: '10px',
    color: '#4a5a6a',
    flexShrink: 0,
    alignItems: 'center',
  },
  statusBadge: (status: string) => {
    const colors: Record<string, { bg: string; color: string }> = {
      accepted: { bg: 'rgba(68,200,100,0.2)', color: '#8fd8a0' },
      rejected: { bg: 'rgba(255,80,80,0.2)', color: '#f8a0a0' },
    }
    const c = colors[status]
    if (!c) return { display: 'none' }
    return {
      padding: '1px 6px',
      borderRadius: '3px',
      fontSize: '9px',
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      background: c.bg,
      color: c.color,
      letterSpacing: '0.5px',
    }
  },
}

// ─── Diff theme ───

const diffTheme = {
  variables: {
    dark: {
      diffViewerBackground: '#0a0e14',
      diffViewerColor: '#c8d0d8',
      addedBackground: 'rgba(68,200,100,0.12)',
      addedColor: '#8fd8a0',
      removedBackground: 'rgba(255,80,80,0.12)',
      removedColor: '#f8a0a0',
      wordAddedBackground: 'rgba(68,200,100,0.25)',
      wordRemovedBackground: 'rgba(255,80,80,0.25)',
      addedGutterBackground: 'rgba(68,200,100,0.08)',
      removedGutterBackground: 'rgba(255,80,80,0.08)',
      gutterBackground: '#0b1018',
      gutterBackgroundDark: '#080c12',
      highlightBackground: 'rgba(68,170,255,0.08)',
      highlightGutterBackground: 'rgba(68,170,255,0.05)',
      codeFoldGutterBackground: '#0d1218',
      codeFoldBackground: '#0d1218',
      emptyLineBackground: '#0a0e14',
      codeFoldContentColor: '#4a5a6a',
    },
  },
  line: {
    fontSize: '12px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  gutter: {
    minWidth: '40px',
    fontSize: '11px',
  },
}

// ─── Syntax highlighting helper ───

const prismLangMap: Record<string, string> = {
  typescript: 'typescript', tsx: 'typescript', javascript: 'javascript',
  jsx: 'javascript', python: 'python', bash: 'bash', json: 'json',
  yaml: 'yaml', css: 'css', sql: 'sql', markdown: 'markdown',
  clojure: 'clojure', java: 'java', go: 'go', rust: 'rust',
  toml: 'toml', text: 'text',
}

function highlightSyntax(str: string, language: string): any {
  const prismLang = prismLangMap[language]
  if (!prismLang || !Prism.languages[prismLang]) {
    return <span>{str}</span>
  }
  const html = Prism.highlight(str, Prism.languages[prismLang], prismLang)
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

// ─── File View Component ───

function FileView({ file }: { file: FileEntry }) {
  const lines = file.content.split('\n')
  const highlightSet = useMemo(() => new Set(file.highlightLines ?? []), [file.highlightLines])
  const annotationMap = useMemo(() => {
    const map = new Map<number, Annotation[]>()
    for (const a of file.annotations ?? []) {
      const list = map.get(a.line) ?? []
      list.push(a)
      map.set(a.line, list)
    }
    return map
  }, [file.annotations])

  return (
    <div style={styles.fileView}>
      <pre style={{ margin: 0, padding: '4px 0' }}>
        {lines.map((line, i) => {
          const lineNum = i + 1
          const isHighlighted = highlightSet.has(lineNum)
          const lineAnnotations = annotationMap.get(lineNum)
          return (
            <span key={i}>
              <code style={styles.codeLine(isHighlighted)}>
                <span style={styles.lineNumber}>{lineNum}</span>
                {highlightSyntax(line, file.language)}
              </code>
              {'\n'}
              {lineAnnotations?.map((a, j) => (
                <code key={`a-${i}-${j}`} style={styles.annotation(a.type ?? 'info')}>
                  {'💬 '}{a.text}
                  {'\n'}
                </code>
              ))}
            </span>
          )
        })}
      </pre>
    </div>
  )
}

// ─── Diff Content Component ───

function DiffContent({
  diffs,
  viewMode,
  mode,
}: {
  diffs: DiffEntry[]
  viewMode: 'inline' | 'side-by-side'
  mode: string
}) {
  const [subTab, setSubTab] = useState(0)

  // Reset sub-tab when diffs change
  useEffect(() => { setSubTab(0) }, [diffs])

  const activeDiff = diffs[subTab] ?? diffs[0]
  if (!activeDiff) return null

  return (
    <>
      {/* Sub-tabs for multi-file diffs within a single viewer tab */}
      {diffs.length > 1 && (
        <div style={styles.tabBar}>
          {diffs.map((d, i) => {
            const fileName = d.path.split('/').pop() ?? d.path
            return (
              <div
                key={i}
                style={styles.tab(i === subTab, 'pending')}
                onClick={() => setSubTab(i)}
              >
                {fileName}
              </div>
            )
          })}
        </div>
      )}
      <div style={styles.content}>
        <ReactDiffViewer
          oldValue={activeDiff.oldContent}
          newValue={activeDiff.newContent}
          splitView={viewMode === 'side-by-side'}
          useDarkTheme={true}
          styles={diffTheme}
          compareMethod={DiffMethod.WORDS}
          renderContent={(str) => highlightSyntax(str ?? '', activeDiff.language)}
          leftTitle={mode === 'compare' ? activeDiff.path.split(' → ')[0] : 'Before'}
          rightTitle={mode === 'compare' ? activeDiff.path.split(' → ')[1] : 'After'}
        />
      </div>
    </>
  )
}

// ─── Main Renderer ───

let tabIdCounter = 0

export function DiffViewerRenderer({ state }: { state: HudComponentState }) {
  const data = state.data as unknown as DiffViewerData | undefined
  const lastHistoryCount = useRef(0)

  const [tabs, setTabs] = useState<ViewerTab[]>([])
  const [activeTabIdx, setActiveTabIdx] = useState(0)
  const [viewMode, setViewMode] = useState<'inline' | 'side-by-side'>('side-by-side')

  // Accumulate new data as tabs — each new hud.update adds a tab
  useEffect(() => {
    if (!data) return
    // Avoid re-adding the same data (historyCount is unique per publish)
    if (data.historyCount === lastHistoryCount.current) return
    lastHistoryCount.current = data.historyCount

    const title = data.title
      ?? (data.mode === 'file' && data.file ? data.file.path.split('/').pop() : undefined)
      ?? (data.diffs?.[0]?.path?.split('/').pop())
      ?? 'View'

    const newTab: ViewerTab = {
      id: `tab-${++tabIdCounter}`,
      title,
      data,
      status: 'pending',
    }

    setTabs(prev => {
      const next = [...prev, newTab]
      // Switch to the new tab
      setTimeout(() => setActiveTabIdx(next.length - 1), 0)
      return next
    })

    if (data.viewMode) setViewMode(data.viewMode)
  }, [data])

  const toggleView = useCallback(() => {
    setViewMode(prev => prev === 'inline' ? 'side-by-side' : 'inline')
  }, [])

  const closeTab = useCallback((idx: number) => {
    const tab = tabs[idx]
    if (!tab) return

    // Build context about what was closed
    const paths = tab.data.diffs?.map(d => d.path).join(', ')
      ?? tab.data.file?.path
      ?? tab.title
    sendAiRequest(`[SYSTEM] User closed diff viewer tab "${tab.title}" (${paths}). Status was: ${tab.status}.`)

    setTabs(prev => {
      const next = prev.filter((_, i) => i !== idx)
      return next
    })
    setActiveTabIdx(prev => {
      if (prev >= tabs.length - 1) return Math.max(0, tabs.length - 2)
      if (prev > idx) return prev - 1
      return prev
    })
  }, [tabs])

  const acceptTab = useCallback((idx: number) => {
    const tab = tabs[idx]
    if (!tab || tab.status !== 'pending') return

    setTabs(prev => prev.map((t, i) => i === idx ? { ...t, status: 'accepted' } : t))

    const paths = tab.data.diffs?.map(d => d.path).join(', ')
      ?? tab.data.file?.path
      ?? tab.title
    const fileCount = tab.data.diffs?.length ?? 1
    sendAiRequest(
      `[SYSTEM] User ACCEPTED the changes in diff "${tab.title}" (${fileCount} file(s): ${paths}). Proceed with these changes.`
    )
  }, [tabs])

  const rejectTab = useCallback((idx: number) => {
    const tab = tabs[idx]
    if (!tab || tab.status !== 'pending') return

    setTabs(prev => prev.map((t, i) => i === idx ? { ...t, status: 'rejected' } : t))

    const paths = tab.data.diffs?.map(d => d.path).join(', ')
      ?? tab.data.file?.path
      ?? tab.title
    const fileCount = tab.data.diffs?.length ?? 1
    sendAiRequest(
      `[SYSTEM] User REJECTED the changes in diff "${tab.title}" (${fileCount} file(s): ${paths}). Please revert or propose alternatives.`
    )
  }, [tabs])

  // Empty state — no tabs
  if (tabs.length === 0) {
    if (!data) return <div style={styles.emptyState}>No data to display</div>
    return <div style={styles.emptyState}>Loading...</div>
  }

  const activeTab = tabs[activeTabIdx] ?? tabs[0]
  const tabData = activeTab.data
  const isDiff = tabData.mode === 'diff' || tabData.mode === 'compare'

  return (
    <div style={styles.container}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.title}>{activeTab.title}</div>
        {isDiff && (
          <button style={styles.toggleBtn(viewMode === 'inline')} onClick={toggleView}>
            {viewMode === 'inline' ? '≡ Inline' : '⇔ Side-by-Side'}
          </button>
        )}
      </div>

      {/* Tab bar — always visible when there are tabs */}
      <div style={styles.tabBar}>
        {tabs.map((tab, i) => {
          const statusIcon = tab.status === 'accepted' ? '✓ ' : tab.status === 'rejected' ? '✗ ' : ''
          return (
            <div
              key={tab.id}
              style={styles.tab(i === activeTabIdx, tab.status)}
              onClick={() => setActiveTabIdx(i)}
            >
              <span>{statusIcon}{tab.title}</span>
              <span
                style={styles.tabClose}
                onClick={(e) => { e.stopPropagation(); closeTab(i) }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.color = '#f88'; (e.target as HTMLElement).style.background = 'rgba(255,80,80,0.15)' }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.color = '#4a5a6a'; (e.target as HTMLElement).style.background = 'transparent' }}
                title="Close tab"
              >✕</span>
            </div>
          )
        })}
      </div>

      {/* Content */}
      {tabData.mode === 'file' && tabData.file ? (
        <div style={styles.content}>
          <FileView file={tabData.file} />
        </div>
      ) : isDiff && tabData.diffs ? (
        <DiffContent diffs={tabData.diffs} viewMode={viewMode} mode={tabData.mode} />
      ) : (
        <div style={styles.emptyState}>No content</div>
      )}

      {/* Footer with stats + accept/reject */}
      <div style={styles.stats}>
        {tabData.mode === 'file' && tabData.file && (
          <>
            <span>{tabData.file.content.split('\n').length} lines</span>
            <span>{tabData.file.content.length} chars</span>
            <span>{tabData.file.language}</span>
          </>
        )}
        {isDiff && tabData.diffs && (() => {
          const totalAdded = tabData.diffs.reduce((sum, d) =>
            sum + d.newContent.split('\n').length - d.oldContent.split('\n').length, 0)
          return (
            <>
              <span>{tabData.diffs.length} file(s)</span>
              <span style={{ color: totalAdded >= 0 ? '#8fd8a0' : '#f8a0a0' }}>
                {totalAdded >= 0 ? `+${totalAdded}` : totalAdded} lines
              </span>
              <span>{tabData.diffs[0]?.language}</span>
            </>
          )
        })()}

        {/* Status badge or accept/reject buttons */}
        <span style={{ flex: 1 }} />
        {activeTab.status === 'pending' && isDiff && (
          <>
            <button
              style={styles.actionBtn('reject')}
              onClick={() => rejectTab(activeTabIdx)}
              title="Reject these changes"
            >✗ Reject</button>
            <button
              style={styles.actionBtn('accept')}
              onClick={() => acceptTab(activeTabIdx)}
              title="Accept these changes"
            >✓ Accept</button>
          </>
        )}
        {activeTab.status !== 'pending' && (
          <span style={styles.statusBadge(activeTab.status)}>
            {activeTab.status === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
          </span>
        )}
      </div>
    </div>
  )
}

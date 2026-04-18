import { useState, useEffect, useMemo, useCallback } from 'react'
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
  tabBar: {
    display: 'flex',
    gap: '0',
    borderBottom: '1px solid #1a2030',
    background: '#0b1018',
    flexShrink: 0,
    overflowX: 'auto' as const,
  },
  tab: (active: boolean) => ({
    padding: '4px 12px',
    fontSize: '10px',
    color: active ? '#4af' : '#6a7a8a',
    borderBottom: active ? '2px solid #4af' : '2px solid transparent',
    cursor: 'pointer',
    background: active ? 'rgba(68,170,255,0.05)' : 'transparent',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap' as const,
  }),
  content: {
    flex: 1,
    overflow: 'auto',
    // CSS containment for performance with large diffs
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

// ─── Main Renderer ───

export function DiffViewerRenderer({ state }: { state: HudComponentState }) {
  const data = state.data as unknown as DiffViewerData | undefined

  const [viewMode, setViewMode] = useState<'inline' | 'side-by-side'>('side-by-side')
  const [activeTab, setActiveTab] = useState(0)

  // Sync with incoming data — reset tab when data changes
  useEffect(() => {
    if (data?.viewMode) setViewMode(data.viewMode)
    setActiveTab(data?.activeTab ?? 0)
  }, [data])

  const toggleView = useCallback(() => {
    setViewMode(prev => prev === 'inline' ? 'side-by-side' : 'inline')
  }, [])

  if (!data) {
    return <div style={styles.emptyState}>No data to display</div>
  }

  // File view mode
  if (data.mode === 'file' && data.file) {
    const lines = data.file.content.split('\n').length
    return (
      <div style={styles.container}>
        <div style={styles.toolbar}>
          <div style={styles.title}>{data.title ?? data.file.path}</div>
          <span style={{ fontSize: '10px', color: '#4a5a6a' }}>{data.file.language}</span>
        </div>
        <div style={styles.content}>
          <FileView file={data.file} />
        </div>
        <div style={styles.stats}>
          <span>{lines} lines</span>
          <span>{data.file.content.length} chars</span>
          <span>{data.file.language}</span>
        </div>
      </div>
    )
  }

  // Diff or compare mode
  const diffs = data.diffs ?? []
  if (diffs.length === 0) {
    return <div style={styles.emptyState}>No diffs to display</div>
  }

  const activeDiff = diffs[activeTab] ?? diffs[0]
  const addedLines = activeDiff.newContent.split('\n').length - activeDiff.oldContent.split('\n').length

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div style={styles.title}>{data.title ?? 'Diff'}</div>
        <button style={styles.toggleBtn(viewMode === 'inline')} onClick={toggleView}>
          {viewMode === 'inline' ? '≡ Inline' : '⇔ Side-by-Side'}
        </button>
      </div>

      {/* Tab bar for multi-file diffs */}
      {diffs.length > 1 && (
        <div style={styles.tabBar}>
          {diffs.map((d, i) => {
            const fileName = d.path.split('/').pop() ?? d.path
            return (
              <div
                key={i}
                style={styles.tab(i === activeTab)}
                onClick={() => setActiveTab(i)}
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
          leftTitle={data.mode === 'compare' ? activeDiff.path.split(' → ')[0] : 'Before'}
          rightTitle={data.mode === 'compare' ? activeDiff.path.split(' → ')[1] : 'After'}
        />
      </div>

      <div style={styles.stats}>
        <span>{activeDiff.path}</span>
        <span style={{ color: addedLines >= 0 ? '#8fd8a0' : '#f8a0a0' }}>
          {addedLines >= 0 ? `+${addedLines}` : addedLines} lines
        </span>
        <span>{activeDiff.language}</span>
        {diffs.length > 1 && <span>File {activeTab + 1}/{diffs.length}</span>}
      </div>
    </div>
  )
}

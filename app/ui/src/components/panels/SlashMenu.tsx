import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

interface SlashItem {
  name: string
  description: string
  category: string
}

interface Props {
  query: string          // text after "/" — e.g. "rea" from "/rea"
  onSelect: (name: string) => void
  onClose: () => void
  visible: boolean
}

const CATEGORY_ORDER = [
  'filesystem', 'web', 'model', 'system', 'pieces', 'actors',
  'cron', 'plugins', 'grpc', 'mcp', 'general',
]

const CATEGORY_COLORS: Record<string, string> = {
  filesystem: '#50fa7b',
  web: '#8be9fd',
  model: '#f1fa8c',
  system: '#ff79c6',
  pieces: '#bd93f9',
  actors: '#ffb86c',
  cron: '#f1fa8c',
  plugins: '#bd93f9',
  grpc: '#8be9fd',
  mcp: '#ff79c6',
  general: '#6272a4',
}

export function SlashMenu({ query, onSelect, onClose, visible }: Props) {
  const [items, setItems] = useState<SlashItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch capabilities once when menu becomes visible, plus built-in system commands
  useEffect(() => {
    if (!visible) return
    fetch('/capabilities')
      .then(r => r.json())
      .then((data: SlashItem[]) => {
        // Add built-in system commands that bypass AI
        const builtins: SlashItem[] = [
          { name: 'clear_session', description: 'Clear conversation history and start fresh (no restart needed)', category: 'system' },
        ]
        setItems([...builtins, ...data])
      })
      .catch(() => setItems([]))
  }, [visible])

  // Fuzzy filter
  const filtered = useMemo(() => {
    if (!query) return items.sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category)
      const bi = CATEGORY_ORDER.indexOf(b.category)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.name.localeCompare(b.name)
    })

    const q = query.toLowerCase()
    return items
      .filter(it => it.name.toLowerCase().includes(q) || it.category.toLowerCase().includes(q))
      .sort((a, b) => {
        // Exact prefix match first
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1
        if (aStarts !== bStarts) return aStarts - bStarts
        return a.name.localeCompare(b.name)
      })
  }, [items, query])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Keyboard navigation — attached to window so it works even when textarea has focus
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!visible) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Tab' || (e.key === 'Enter' && filtered.length > 0)) {
      e.preventDefault()
      e.stopPropagation()
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex].name)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [visible, filtered, selectedIndex, onSelect, onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true) // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  if (!visible || filtered.length === 0) return null

  return (
    <div style={{
      position: 'absolute',
      bottom: '100%',
      left: 0,
      right: 0,
      maxHeight: '240px',
      overflowY: 'auto',
      background: '#141824',
      border: '1px solid var(--panel-border)',
      borderBottom: 'none',
      borderRadius: '4px 4px 0 0',
      zIndex: 100,
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
    }} ref={listRef}>
      {filtered.map((item, i) => (
        <div
          key={item.name}
          onClick={() => onSelect(item.name)}
          onMouseEnter={() => setSelectedIndex(i)}
          style={{
            padding: '5px 10px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: i === selectedIndex ? 'rgba(255,255,255,0.06)' : 'transparent',
            borderLeft: i === selectedIndex ? '2px solid #4af' : '2px solid transparent',
          }}
        >
          <span style={{
            color: CATEGORY_COLORS[item.category] ?? '#6272a4',
            fontSize: '8px',
            fontFamily: 'var(--font-display)',
            letterSpacing: '1px',
            minWidth: '70px',
            textTransform: 'uppercase',
          }}>
            [{item.category}]
          </span>
          <span style={{ color: '#f8f8f2', fontWeight: 500 }}>
            /{item.name}
          </span>
          <span style={{
            color: '#6272a4',
            fontSize: '10px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {item.description}
          </span>
        </div>
      ))}
    </div>
  )
}

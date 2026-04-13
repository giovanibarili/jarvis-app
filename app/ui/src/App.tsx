// ui/src/App.tsx
import { useState, useEffect } from 'react'
import type { HudState } from './types/hud'
import { HudRenderer } from './components/HudRenderer'

const DEFAULT_STATE: HudState = {
  reactor: { status: 'offline', coreLabel: 'CONNECTING', coreSubLabel: '...' },
  components: [],
}

export function App() {
  const [state, setState] = useState<HudState>(DEFAULT_STATE)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        fetch('/chat/abort', { method: 'POST' }).catch(() => {})
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/hud')
        if (res.ok) {
          setState(await res.json())
        }
      } catch {
        setState(DEFAULT_STATE)
      }
    }

    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [])

  return <HudRenderer state={state} />
}

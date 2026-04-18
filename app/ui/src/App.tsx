// ui/src/App.tsx
import { useState, useEffect, useRef } from 'react'
import type { HudState } from './types/hud'
import { HudRenderer } from './components/HudRenderer'
import { DetachedPanelRenderer } from './components/DetachedPanelRenderer'

const DEFAULT_STATE: HudState = {
  reactor: { status: 'offline', coreLabel: 'CONNECTING', coreSubLabel: '...' },
  components: [],
}

// Inject theme CSS vars into a <style> tag, hot-reloading on change
function useTheme() {
  const styleRef = useRef<HTMLStyleElement | null>(null)

  useEffect(() => {
    // Create a dedicated <style> tag for theme vars
    const el = document.createElement('style')
    el.id = 'jarvis-theme'
    document.head.appendChild(el)
    styleRef.current = el

    const apply = async () => {
      try {
        const res = await fetch('/theme/active')
        if (!res.ok) return
        const { vars } = await res.json()
        if (!vars || Object.keys(vars).length === 0) {
          el.textContent = '' // reset to default
          return
        }
        const css = `:root {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`
        el.textContent = css
      } catch {
        // server not ready yet, ignore
      }
    }

    apply()
    // Poll for theme changes every 3s (picks up theme switches instantly)
    const interval = setInterval(apply, 3000)
    return () => {
      clearInterval(interval)
      el.remove()
    }
  }, [])
}

/** Check if this window should render a single detached panel */
function getDetachedPanelId(): string | null {
  const params = new URLSearchParams(window.location.search)
  return params.get('panel')
}

export function App() {
  const [state, setState] = useState<HudState>(DEFAULT_STATE)
  useTheme()

  const detachedPanelId = getDetachedPanelId()

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

  // Detached panel mode: render only the requested panel
  if (detachedPanelId) {
    return <DetachedPanelRenderer state={state} panelId={detachedPanelId} />
  }

  return <HudRenderer state={state} />
}

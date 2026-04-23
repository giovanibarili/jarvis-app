import * as React from 'react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './hud.css'

// Expose React for plugin renderers (they use window.__JARVIS_REACT to share the same instance)
;(window as any).__JARVIS_REACT = React

// Expose core UI components for plugin reuse and HUD-mounted core renderers.
// A HUD piece can declare `renderer: { plugin: null, file: 'ChatPanel' }` and
// the HudRenderer resolves it from this registry. Plugins can also import
// ChatPanel directly via window.__JARVIS_COMPONENTS.
import { ChatPanel } from './components/panels/ChatPanel'
import { ChatPanelHudAdapter } from './components/panels/ChatPanelHudAdapter'
;(window as any).__JARVIS_COMPONENTS = {
  // Raw component — plugins can wrap or compose.
  ChatPanel,
  // HUD-friendly wrapper — used when a piece publishes a panel with
  // renderer.plugin === null, renderer.file === 'ChatPanel'.
  ChatPanelHudAdapter,
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

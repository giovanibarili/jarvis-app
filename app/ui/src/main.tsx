import * as React from 'react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './hud.css'

// Expose React for plugin renderers (they use window.__JARVIS_REACT to share the same instance)
;(window as any).__JARVIS_REACT = React

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

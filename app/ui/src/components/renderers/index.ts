import type { ReactNode } from 'react'
import type { HudComponentState } from '../../types/hud'
import { JarvisCoreRenderer } from './JarvisCoreRenderer'
import { GrpcRenderer } from './GrpcRenderer'
import { TokenCounterRenderer } from './TokenCounterRenderer'
import { CapabilityExecutorRenderer } from './CapabilityExecutorRenderer'
import { McpManagerRenderer } from './McpManagerRenderer'
import { DiffViewerRenderer } from './DiffViewerRenderer'
// ChatInput & ChatOutput rendered directly in HudRenderer as docked chat
// ActorPoolRenderer imported directly in HudRenderer (needs click handler)
// CoreNodeOverlay rendered directly in HudRenderer (wraps the orb)

type Renderer = (props: { state: HudComponentState }) => ReactNode

export const renderers: Record<string, Renderer> = {
  "jarvis-core": JarvisCoreRenderer,
  "grpc": GrpcRenderer,
  "token-counter": TokenCounterRenderer,
  "capability-executor": CapabilityExecutorRenderer,
  "mcp-manager": McpManagerRenderer,
  "diff-viewer": DiffViewerRenderer,
  // actor-pool rendered specially in HudRenderer (needs click handler)
  // plugin renderers loaded dynamically (phase 2)
}

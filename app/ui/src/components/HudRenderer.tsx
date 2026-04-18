import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import type { HudState } from '../types/hud'
import { DraggablePanel } from './DraggablePanel'
import { renderers } from './renderers/index'
import { CoreNodeOverlay } from './CoreNodeOverlay'
import { ActorPoolRenderer } from './renderers/ActorPoolRenderer'
import { ChatPanel } from './panels/ChatPanel'

// Cache for lazily loaded plugin renderers
const pluginRendererCache: Record<string, React.LazyExoticComponent<React.ComponentType<{ state: any }>>> = {}

function getPluginRenderer(plugin: string, file: string) {
  const key = `${plugin}/${file}`
  if (!pluginRendererCache[key]) {
    pluginRendererCache[key] = lazy(() =>
      import(/* @vite-ignore */ `/plugins/${plugin}/renderers/${file}.js`)
    )
  }
  return pluginRendererCache[key]
}

function GenericRenderer({ state }: { state: any }) {
  return (
    <div style={{ padding: '8px', fontSize: '10px', color: '#8af', fontFamily: 'monospace' }}>
      <div style={{ marginBottom: '4px', opacity: 0.7 }}>STATUS: {state.status}</div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#6af' }}>
        {JSON.stringify(state.data, null, 2)}
      </pre>
    </div>
  )
}

export function HudRenderer({ state }: { state: HudState }) {
  const coreComp = state.components.find(c => c.id === 'jarvis-core')
  const coreNodeComp = state.components.find(c => c.id === 'hud-core-node')
  const chatOutputComp = state.components.find(c => c.id === 'chat-output')
  const chatInputComp = state.components.find(c => c.id === 'chat-input')
  const otherComps = state.components.filter(c => c.id !== 'jarvis-core' && c.id !== 'actor-pool' && c.id !== 'chat-output' && c.id !== 'chat-input' && c.id !== 'hud-core-node' && c.visible !== false)
  const actorPoolComp = state.components.find(c => c.id === 'actor-pool')

  const [openChats, setOpenChats] = useState<string[]>([])
  const [hiddenPanels, setHiddenPanels] = useState<Set<string>>(new Set())
  const [detachedPanels, setDetachedPanels] = useState<Set<string>>(new Set())

  // Load persisted detached state on mount
  useEffect(() => {
    fetch('/hud/detached').then(r => r.json()).then((panels: Array<{ panelId: string }>) => {
      if (panels.length > 0) {
        setDetachedPanels(new Set(panels.map(p => p.panelId)))
      }
    }).catch(() => {})
  }, [])

  const hidePanel = useCallback((pieceId: string) => {
    setHiddenPanels(prev => new Set([...prev, pieceId]))
    fetch('/hud/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pieceId }),
    }).catch(() => {})
  }, [])

  const detachPanel = useCallback((pieceId: string) => {
    const comp = state.components.find(c => c.id === pieceId)
    // Optimistically hide, but revert if request fails
    setDetachedPanels(prev => new Set([...prev, pieceId]))
    fetch('/hud/detach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        panelId: pieceId,
        title: comp?.name?.toUpperCase() ?? pieceId,
        width: comp?.size.width ?? 500,
        height: comp?.size.height ?? 400,
      }),
    }).then(r => {
      if (!r.ok) throw new Error('detach failed')
    }).catch(() => {
      // Revert — re-show the panel
      setDetachedPanels(prev => {
        const next = new Set(prev)
        next.delete(pieceId)
        return next
      })
    })
  }, [state.components])

  // Listen for reattach events from Electron main process
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.panelId) {
        setDetachedPanels(prev => {
          const next = new Set(prev)
          next.delete(detail.panelId)
          return next
        })
      }
    }
    window.addEventListener('panel-reattach', handler)
    return () => window.removeEventListener('panel-reattach', handler)
  }, [])

  const statusColor = state.reactor.status === 'online' ? '#4af'
    : state.reactor.status === 'processing' ? '#fa4'
    : state.reactor.status === 'waiting_tools' ? '#a6f'
    : state.reactor.status === 'loading' ? '#a6f'
    : '#f44'

  const openActorChat = useCallback((name: string) => {
    setOpenChats(prev => prev.includes(name) ? prev : [...prev, name])
  }, [])

  const closeActorChat = useCallback((name: string) => {
    setOpenChats(prev => prev.filter(n => n !== name))
  }, [])

  const killActor = useCallback((name: string) => {
    fetch(`http://localhost:50052/plugins/actors/${name}/kill`, {
      method: 'POST',
    }).catch(() => {})
    setOpenChats(prev => prev.filter(n => n !== name))
  }, [])

  return (
    <div className="hudRoot">
      <div className="hudDragBar">
        <div className="hudDragBarHandle" />
      </div>

      <div className="hudContent">
        {coreComp && (
          <div className="hudOrbContainer">
            {/* Graph overlay — nebula swarm for all nodes including root */}
            <CoreNodeOverlay coreNodeState={coreNodeComp} reactorStatus={state.reactor.status} />
            {/* JARVIS label floats at center */}
            <div className="coreNodeLabel" style={{ color: statusColor }}>
              <div style={{ fontSize: '14px', letterSpacing: '6px' }}>J A R V I S</div>
              <div style={{ fontSize: '8px', letterSpacing: '2px', marginTop: '4px', opacity: 0.7 }}>
                {state.reactor.status.toUpperCase().replace('_', ' ')}
              </div>
            </div>
          </div>
        )}

        {/* Chat — unified ChatPanel for main session */}
        {(chatOutputComp || chatInputComp) && !detachedPanels.has('chat-output') && (
          <DraggablePanel
            key="chat-docked"
            id="CHAT"
            pieceId="chat-output"
            onDetach={detachPanel}
            defaultX={chatOutputComp?.position.x ?? 10}
            defaultY={chatOutputComp?.position.y ?? 400}
            defaultWidth={chatOutputComp?.size.width ?? 1660}
            defaultHeight={(chatOutputComp?.size.height ?? 280) + (chatInputComp?.size.height ?? 44)}
            minWidth={300}
            minHeight={120}
          >
            <ChatPanel
              streamUrl="/chat-stream"
              sendUrl="/chat/send"
              abortUrl="/chat/abort"
              assistantLabel="JARVIS"
            />
          </DraggablePanel>
        )}

        {/* Regular panels */}
        {otherComps.filter(c => !hiddenPanels.has(c.id) && !detachedPanels.has(c.id)).map(comp => {
          // 1. Try built-in renderer
          const BuiltinRenderer = renderers[comp.id]

          if (BuiltinRenderer) {
            return (
              <DraggablePanel
                key={comp.id}
                id={comp.name.toUpperCase()}
                pieceId={comp.id}
                defaultX={comp.position.x}
                defaultY={comp.position.y}
                defaultWidth={comp.size.width}
                defaultHeight={comp.size.height}
                minWidth={100}
                minHeight={60}
                onClose={() => hidePanel(comp.id)}
                onDetach={detachPanel}
                persistLayout={!comp.ephemeral}
              >
                <BuiltinRenderer state={comp} />
              </DraggablePanel>
            )
          }

          // 2. Try plugin renderer (lazy loaded)
          if (comp.renderer) {
            const PluginRenderer = getPluginRenderer(comp.renderer.plugin, comp.renderer.file)
            return (
              <DraggablePanel
                key={comp.id}
                id={comp.name.toUpperCase()}
                pieceId={comp.id}
                defaultX={comp.position.x}
                defaultY={comp.position.y}
                defaultWidth={comp.size.width}
                defaultHeight={comp.size.height}
                minWidth={100}
                minHeight={60}
                onClose={() => hidePanel(comp.id)}
                onDetach={detachPanel}
                persistLayout={!comp.ephemeral}
              >
                <Suspense fallback={<GenericRenderer state={comp} />}>
                  <PluginRenderer state={comp} />
                </Suspense>
              </DraggablePanel>
            )
          }

          // 3. Generic fallback for pieces with data but no renderer
          if (comp.data && Object.keys(comp.data).length > 0) {
            return (
              <DraggablePanel
                key={comp.id}
                id={comp.name.toUpperCase()}
                pieceId={comp.id}
                defaultX={comp.position.x}
                defaultY={comp.position.y}
                defaultWidth={comp.size.width}
                defaultHeight={comp.size.height}
                minWidth={100}
                minHeight={60}
                onClose={() => hidePanel(comp.id)}
                onDetach={detachPanel}
                persistLayout={!comp.ephemeral}
              >
                <GenericRenderer state={comp} />
              </DraggablePanel>
            )
          }

          return null
        })}

        {/* Actor Pool — special: passes click handler */}
        {actorPoolComp && actorPoolComp.visible !== false && !detachedPanels.has(actorPoolComp.id) && (
          <DraggablePanel
            key={actorPoolComp.id}
            id={actorPoolComp.name.toUpperCase()}
            pieceId={actorPoolComp.id}
            defaultX={actorPoolComp.position.x}
            defaultY={actorPoolComp.position.y}
            defaultWidth={actorPoolComp.size.width}
            defaultHeight={actorPoolComp.size.height}
            minWidth={100}
            minHeight={60}
          >
            <ActorPoolRenderer state={actorPoolComp} onActorClick={openActorChat} onActorKill={killActor} />
          </DraggablePanel>
        )}

        {/* Actor chat panels — same ChatPanel, different URLs */}
        {openChats.map((name, i) => (
          <DraggablePanel
            key={`actor-chat-${name}`}
            id={`ACTOR: ${name.toUpperCase()}`}
            pieceId={`actor-chat-${name}`}
            defaultX={200 + i * 30}
            defaultY={100 + i * 30}
            defaultWidth={500}
            defaultHeight={350}
            minWidth={300}
            minHeight={200}
            onClose={() => closeActorChat(name)}
            persistLayout={false}  // actor chats are always ephemeral
          >
            <ChatPanel
              streamUrl={`http://localhost:50052/plugins/actors/${name}/stream`}
              sendUrl={`http://localhost:50052/plugins/actors/${name}/send`}
              abortUrl={`http://localhost:50052/plugins/actors/${name}/abort`}
              historyUrl={`http://localhost:50052/plugins/actors/${name}/history`}
              assistantLabel={name.toUpperCase()}
              features={{ slashMenu: true, images: false, abort: true, compaction: false }}
              userLabel={(source) => {
                if (source === 'jarvis') return 'JARVIS'
                if (source === 'grpc') return 'GRPC'
                if (source?.startsWith('actor:')) return source.replace('actor:', '').toUpperCase()
                return 'YOU'
              }}
              userLabelColor={(source) => {
                if (source === 'jarvis') return '#4af'
                if (source === 'grpc') return '#fa4'
                if (source?.startsWith('actor:')) return '#f8a'
                return 'var(--chat-user-label)'
              }}
            />
          </DraggablePanel>
        ))}
      </div>
    </div>
  )
}

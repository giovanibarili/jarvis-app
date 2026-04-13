import { useState, useCallback, lazy, Suspense } from 'react'
import type { HudState } from '../types/hud'
import { DraggablePanel } from './DraggablePanel'
import { renderers } from './renderers/index'
import { ReactorCore } from './ReactorCore'
import { ActorPoolRenderer } from './renderers/ActorPoolRenderer'
import { ActorChat } from './panels/ActorChat'
import { ChatOutput } from './panels/ChatOutput'
import { ChatInput } from './panels/ChatInput'

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
  const chatOutputComp = state.components.find(c => c.id === 'chat-output')
  const chatInputComp = state.components.find(c => c.id === 'chat-input')
  const otherComps = state.components.filter(c => c.id !== 'jarvis-core' && c.id !== 'actor-pool' && c.id !== 'chat-output' && c.id !== 'chat-input' && c.visible !== false)
  const actorPoolComp = state.components.find(c => c.id === 'actor-pool')

  const [openChats, setOpenChats] = useState<string[]>([])
  const [hiddenPanels, setHiddenPanels] = useState<Set<string>>(new Set())

  const reactorSize = 180

  const hidePanel = useCallback((pieceId: string) => {
    setHiddenPanels(prev => new Set([...prev, pieceId]))
    fetch('/hud/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pieceId }),
    }).catch(() => {})
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
            <ReactorCore reactor={state.reactor} size={reactorSize} />
            <div className="statusLabel" style={{ color: statusColor, marginTop: '8px', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', letterSpacing: '6px' }}>J A R V I S</div>
              <div style={{ fontSize: '8px', letterSpacing: '2px', marginTop: '4px', opacity: 0.7 }}>
                {state.reactor.status.toUpperCase().replace('_', ' ')}
              </div>
            </div>
          </div>
        )}

        {/* Chat — docked panel: draggable + resizable, output fills space, input grows */}
        {(chatOutputComp || chatInputComp) && (
          <DraggablePanel
            key="chat-docked"
            id="CHAT"
            pieceId="chat-output"
            defaultX={chatOutputComp?.position.x ?? 10}
            defaultY={chatOutputComp?.position.y ?? 400}
            defaultWidth={chatOutputComp?.size.width ?? 1660}
            defaultHeight={(chatOutputComp?.size.height ?? 280) + (chatInputComp?.size.height ?? 44)}
            minWidth={300}
            minHeight={120}
          >
            <div className="chatDocked">
              {chatOutputComp && chatOutputComp.visible !== false && (
                <div className="chatDockedOutput">
                  <ChatOutput />
                </div>
              )}
              {chatInputComp && chatInputComp.visible !== false && (
                <div className="chatDockedInput">
                  <ChatInput />
                </div>
              )}
            </div>
          </DraggablePanel>
        )}

        {/* Regular panels */}
        {otherComps.filter(c => !hiddenPanels.has(c.id)).map(comp => {
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
              >
                <GenericRenderer state={comp} />
              </DraggablePanel>
            )
          }

          return null
        })}

        {/* Actor Pool — special: passes click handler */}
        {actorPoolComp && actorPoolComp.visible !== false && (
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

        {/* Actor chat panels */}
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
          >
            <ActorChat actorName={name} />
          </DraggablePanel>
        ))}
      </div>
    </div>
  )
}

// CoreNodeOverlay.tsx
// Force-directed graph overlay that renders around the existing ReactorCore orb.
// The orb stays untouched — this canvas sits behind it, drawing nodes and edges
// that radiate from the orb's center position.

import { useRef, useEffect, useState, useCallback } from 'react'
import type { HudComponentState } from '../types/hud'
import { ForceSimulation } from './renderers/core-node/physics'
import { drawGraph, hitTest } from './renderers/core-node/renderer'

interface TreeNode {
  id: string
  label: string
  status: string
  parentId: string | null
  meta?: Record<string, unknown>
}

export function CoreNodeOverlay({ coreNodeState, reactorStatus }: { coreNodeState?: HudComponentState; reactorStatus?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef(new ForceSimulation())
  const rafRef = useRef<number>(0)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: TreeNode } | null>(null)
  const draggingRef = useRef<string | null>(null)

  const labelsRef = useRef(new Map<string, string>())
  const statusesRef = useRef(new Map<string, string>())
  const treeRef = useRef<TreeNode[]>([])

  // Sync tree data
  useEffect(() => {
    const tree = (coreNodeState?.data?.tree as TreeNode[]) ?? []
    treeRef.current = tree

    const labels = new Map<string, string>()
    const statuses = new Map<string, string>()
    for (const n of tree) {
      labels.set(n.id, n.label)
      statuses.set(n.id, n.status)
    }
    // Override root node status with live reactor status
    if (reactorStatus) {
      statuses.set('jarvis-core', reactorStatus)
    }
    labelsRef.current = labels
    statusesRef.current = statuses
  }, [coreNodeState?.data?.tree, reactorStatus])

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const sim = simRef.current
    let running = true

    function loop() {
      if (!running || !canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const container = canvas.parentElement
      if (!container) return

      const w = container.clientWidth
      const h = container.clientHeight

      if (canvas.width !== w * 2 || canvas.height !== h * 2) {
        canvas.width = w * 2
        canvas.height = h * 2
        canvas.style.width = w + 'px'
        canvas.style.height = h + 'px'
        ctx.scale(2, 2)
      }

      // Center = where the orb is (center of container)
      sim.setCenter(w / 2, h / 2)
      sim.sync(treeRef.current)
      sim.tick()

      drawGraph(
        ctx,
        sim.nodes,
        sim.edges,
        hoveredId,
        labelsRef.current,
        statusesRef.current,
        w,
        h,
      )

      rafRef.current = requestAnimationFrame(loop)
    }

    loop()

    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [hoveredId])

  // ── Mouse interaction ──

  const getLocalCoords = useCallback((e: React.MouseEvent) => {
    const container = canvasRef.current?.parentElement
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const coords = getLocalCoords(e)
    if (!coords) return
    const hit = hitTest(simRef.current.nodes, coords.x, coords.y)
    if (hit && hit !== 'jarvis-core') {
      draggingRef.current = hit
      const node = simRef.current.nodes.get(hit)
      if (node) {
        node.pinned = true
        simRef.current.settled = false
      }
      e.preventDefault()
    }
  }, [getLocalCoords])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const coords = getLocalCoords(e)
    if (!coords) return

    // Dragging
    if (draggingRef.current) {
      const node = simRef.current.nodes.get(draggingRef.current)
      if (node) {
        node.x = coords.x
        node.y = coords.y
        simRef.current.settled = false
      }
      setTooltip(null)
      return
    }

    // Hover
    const hit = hitTest(simRef.current.nodes, coords.x, coords.y)
    setHoveredId(hit)

    if (hit && hit !== 'jarvis-core') {
      const treeNode = treeRef.current.find(n => n.id === hit)
      if (treeNode) {
        setTooltip({ x: coords.x + 12, y: coords.y - 8, node: treeNode })
        return
      }
    }
    setTooltip(null)
  }, [getLocalCoords])

  const handleMouseUp = useCallback(() => {
    if (draggingRef.current) {
      // Node stays pinned where it was dropped
      draggingRef.current = null
    }
  }, [])

  const handleMouseLeave = useCallback(() => {
    // Stop dragging but keep pinned
    draggingRef.current = null
    setHoveredId(null)
    setTooltip(null)
  }, [])

  if (!coreNodeState) return null

  return (
    <div
      className="coreNodeOverlay"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{ cursor: draggingRef.current ? 'grabbing' : (hoveredId && hoveredId !== 'jarvis-core' ? 'grab' : 'default') }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x,
            top: tooltip.y,
            background: 'rgba(10, 10, 15, 0.92)',
            border: '1px solid var(--panel-border)',
            borderRadius: '4px',
            padding: '6px 10px',
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-value)',
            pointerEvents: 'none',
            zIndex: 20,
            whiteSpace: 'nowrap',
            maxWidth: '200px',
          }}
        >
          <div style={{ fontWeight: 'bold', marginBottom: '2px' }}>{tooltip.node.label}</div>
          <div style={{ color: 'var(--color-label)' }}>
            status: <span style={{ color: 'var(--color-value)' }}>{tooltip.node.status}</span>
          </div>
          {tooltip.node.meta && Object.entries(tooltip.node.meta).map(([k, v]) => (
            <div key={k} style={{ color: 'var(--color-label)' }}>
              {k}: <span style={{ color: 'var(--color-value)' }}>{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

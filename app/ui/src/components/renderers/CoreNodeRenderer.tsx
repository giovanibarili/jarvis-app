// CoreNodeRenderer.tsx
// React wrapper for the hud-core-node force-directed graph.
// Canvas for rendering + DOM overlay for hover tooltips.

import { useRef, useEffect, useState, useCallback } from 'react'
import type { HudComponentState } from '../../types/hud'
import { ForceSimulation } from './core-node/physics'
import { drawGraph, hitTest } from './core-node/renderer'

interface TreeNode {
  id: string
  label: string
  status: string
  parentId: string | null
  meta?: Record<string, unknown>
}

export function CoreNodeRenderer({ state }: { state: HudComponentState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef(new ForceSimulation())
  const rafRef = useRef<number>(0)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: TreeNode } | null>(null)

  // Keep labels & statuses in sync
  const labelsRef = useRef(new Map<string, string>())
  const statusesRef = useRef(new Map<string, string>())
  const treeRef = useRef<TreeNode[]>([])

  // Sync tree data from HUD state
  useEffect(() => {
    const tree = (state.data?.tree as TreeNode[]) ?? []
    treeRef.current = tree

    const labels = new Map<string, string>()
    const statuses = new Map<string, string>()
    for (const n of tree) {
      labels.set(n.id, n.label)
      statuses.set(n.id, n.status)
    }
    labelsRef.current = labels
    statusesRef.current = statuses
  }, [state.data?.tree])

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

      const rect = canvas.parentElement?.getBoundingClientRect()
      const w = rect?.width ?? 600
      const h = rect?.height ?? 400

      // Resize canvas to fill container
      if (canvas.width !== w * 2 || canvas.height !== h * 2) {
        canvas.width = w * 2
        canvas.height = h * 2
        canvas.style.width = w + 'px'
        canvas.style.height = h + 'px'
        ctx.scale(2, 2)
      }

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

  // Mouse interaction
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.parentElement?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const sim = simRef.current
    const hit = hitTest(sim.nodes, x, y)
    setHoveredId(hit)

    if (hit) {
      const treeNode = treeRef.current.find(n => n.id === hit)
      if (treeNode) {
        setTooltip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8, node: treeNode })
      }
    } else {
      setTooltip(null)
    }
  }, [])

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null)
    setTooltip(null)
  }, [])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />

      {/* Tooltip overlay */}
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
            zIndex: 10,
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

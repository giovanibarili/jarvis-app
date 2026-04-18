// core-node/renderer.ts
// Canvas drawing — Nebula Swarm style.
// Each node is a cloud of orbiting particles with glow.
// Edges have wisps traveling along them.

import type { PhysicsNode, PhysicsEdge } from './physics'

// ── Per-node swarm state (lazy-initialized, keyed by node id) ──

interface SwarmParticle {
  angle: number
  speed: number
  size: number
  phase: number
  orbitRadius: number
}

const swarmCache = new Map<string, SwarmParticle[]>()

function getSwarm(id: string, r: number, isRoot: boolean): SwarmParticle[] {
  let swarm = swarmCache.get(id)
  if (swarm) return swarm

  const count = isRoot ? 14 : 7
  const pts: SwarmParticle[] = []
  for (let j = 0; j < count; j++) {
    pts.push({
      angle: Math.random() * Math.PI * 2,
      speed: isRoot ? (0.15 + Math.random() * 0.3) : (0.3 + Math.random() * 0.5),
      size: isRoot ? (5 + Math.random() * 6) : (2.5 + Math.random() * 2),
      phase: Math.random() * Math.PI * 2,
      orbitRadius: r * (isRoot ? (0.5 + Math.random() * 0.7) : (0.4 + Math.random() * 0.8)),
    })
  }
  swarmCache.set(id, pts)
  return pts
}

/** Clean up swarm state for removed nodes */
export function pruneSwarmCache(activeIds: Set<string>) {
  for (const id of swarmCache.keys()) {
    if (!activeIds.has(id)) swarmCache.delete(id)
  }
}

// ── Status color palettes ──

const STATUS_COLORS: Record<string, [number, number, number]> = {
  running:        [0, 200, 130],
  connected:      [0, 200, 130],
  online:         [68, 170, 255],
  processing:     [255, 170, 68],
  waiting_tools:  [170, 102, 255],
  loading:        [170, 102, 255],
  initializing:   [170, 102, 255],
  idle:           [90, 140, 180],
  starting:       [255, 170, 68],
  connecting:     [255, 170, 68],
  stopped:        [75, 75, 75],
  disconnected:   [75, 75, 75],
  offline:        [255, 68, 68],
  error:          [211, 47, 47],
  auth_required:  [255, 87, 34],
}

function getColor(status: string): [number, number, number] {
  return STATUS_COLORS[status] ?? [90, 140, 180]
}

// ── Main draw ──

export function drawGraph(
  ctx: CanvasRenderingContext2D,
  nodes: Map<string, PhysicsNode>,
  edges: PhysicsEdge[],
  hoveredId: string | null,
  nodeLabels: Map<string, string>,
  nodeStatuses: Map<string, string>,
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h)
  const t = Date.now() / 1000

  // Prune stale swarms
  const activeIds = new Set(nodes.keys())
  pruneSwarmCache(activeIds)

  // ── Edges: faint line + wisps ──
  for (const edge of edges) {
    const source = nodes.get(edge.sourceId)
    const target = nodes.get(edge.targetId)
    if (!source || !target) continue

    const alpha = Math.min(source.alpha, target.alpha)
    if (alpha <= 0) continue

    const status = nodeStatuses.get(edge.targetId) ?? 'running'
    const c = getColor(status)

    // Faint line
    ctx.globalAlpha = alpha * 0.1
    ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()

    // Wisps traveling along edge
    const numWisps = 3
    for (let wi = 0; wi < numWisps; wi++) {
      // Use edge index for variety
      const edgeSeed = edge.sourceId.length + edge.targetId.length + wi * 0.37
      const prog = ((t * 0.15 + wi / numWisps + edgeSeed * 0.1) % 1)
      const wx = source.x + (target.x - source.x) * prog
      const wy = source.y + (target.y - source.y) * prog
      const wAlpha = Math.sin(prog * Math.PI) * 0.4 * alpha

      ctx.globalAlpha = wAlpha
      const wg = ctx.createRadialGradient(wx, wy, 0, wx, wy, 5)
      wg.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.8)`)
      wg.addColorStop(1, 'transparent')
      ctx.fillStyle = wg
      ctx.beginPath()
      ctx.arc(wx, wy, 5, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ── Nodes ──
  const nodeArray = [...nodes.values()]
  for (const node of nodeArray) {
    if (node.alpha <= 0) continue

    const status = nodeStatuses.get(node.id) ?? 'running'
    const c = getColor(status)
    const isRoot = node.parentId === null
    const isHovered = node.id === hoveredId
    const label = nodeLabels.get(node.id) ?? node.id

    let r = node.radius
    if (status === 'processing') {
      r += Math.sin(t * 3) * 1.5
    }
    if (isHovered) r += 2

    ctx.globalAlpha = node.alpha

    // ── Ambient glow ──
    ctx.globalAlpha = node.alpha * 0.3
    const ag = ctx.createRadialGradient(node.x, node.y, r * 0.2, node.x, node.y, r * 2.8)
    ag.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.4)`)
    ag.addColorStop(1, 'transparent')
    ctx.fillStyle = ag
    ctx.beginPath()
    ctx.arc(node.x, node.y, r * 2.8, 0, Math.PI * 2)
    ctx.fill()

    // ── Orbiting particles ──
    const swarm = getSwarm(node.id, r, isRoot)
    for (const p of swarm) {
      const a = p.angle + t * p.speed
      const breathe = 1 + 0.2 * Math.sin(t * 1.5 + p.phase)
      const d = p.orbitRadius * breathe
      const px = node.x + Math.cos(a) * d
      const py = node.y + Math.sin(a) * d

      const pulseAlpha = 0.5 + 0.4 * Math.sin(t * 2 + p.phase)
      ctx.globalAlpha = node.alpha * pulseAlpha

      const pg = ctx.createRadialGradient(px, py, 0, px, py, p.size * 2)
      pg.addColorStop(0, `rgba(${Math.min(c[0]+60,255)},${Math.min(c[1]+60,255)},${Math.min(c[2]+60,255)},0.9)`)
      pg.addColorStop(0.4, `rgba(${c[0]},${c[1]},${c[2]},0.5)`)
      pg.addColorStop(1, 'transparent')
      ctx.fillStyle = pg
      ctx.beginPath()
      ctx.arc(px, py, p.size * 2, 0, Math.PI * 2)
      ctx.fill()
    }

    // ── Core point ──
    ctx.globalAlpha = node.alpha * 0.85
    const coreR = isRoot ? 10 : 4
    const cg = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, coreR)
    cg.addColorStop(0, 'rgba(255,255,255,0.6)')
    cg.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},0.5)`)
    cg.addColorStop(1, 'transparent')
    ctx.fillStyle = cg
    ctx.beginPath()
    ctx.arc(node.x, node.y, coreR, 0, Math.PI * 2)
    ctx.fill()

    // ── Hover ring ──
    if (isHovered) {
      ctx.globalAlpha = node.alpha * 0.4
      ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.5)`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(node.x, node.y, r * 2, 0, Math.PI * 2)
      ctx.stroke()
    }

    // ── Label (skip root — HudRenderer renders JARVIS label separately) ──
    if (!isRoot) {
      ctx.globalAlpha = node.alpha * 0.75
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`
      ctx.font = '10px "JetBrains Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillText(label, node.x, node.y + r * 2.2 + 12)
    }
  }

  ctx.globalAlpha = 1
}

/**
 * Find the node under the given point (if any).
 */
export function hitTest(
  nodes: Map<string, PhysicsNode>,
  x: number,
  y: number,
  hitRadius = 20,
): string | null {
  let closest: string | null = null
  let closestDist = Infinity
  for (const node of nodes.values()) {
    if (node.alpha <= 0.1) continue
    const dx = node.x - x
    const dy = node.y - y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const threshold = Math.max(node.radius * 2, hitRadius)
    if (dist < threshold && dist < closestDist) {
      closest = node.id
      closestDist = dist
    }
  }
  return closest
}

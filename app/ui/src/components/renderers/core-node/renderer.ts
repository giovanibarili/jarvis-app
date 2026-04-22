// core-node/renderer.ts
// Canvas drawing — Nebula Swarm style.
// Each node is a cloud of orbiting particles with glow.
// Edges have wisps traveling along them.
// Status-driven intensity: each status has a unique energy profile.

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
  disabled:       [75, 75, 75],
  stopped:        [75, 75, 75],
  disconnected:   [75, 75, 75],
  offline:        [255, 68, 68],
  error:          [211, 47, 47],
  auth_required:  [255, 87, 34],
}

function getColor(status: string): [number, number, number] {
  return STATUS_COLORS[status] ?? [90, 140, 180]
}

// ── Status energy profiles ──
// Controls visual intensity per status.
//   orbitSpeed: multiplier on particle orbit speed (1 = default)
//   breatheAmp: amplitude of orbit breathing oscillation (0 = static, 0.2 = gentle, 0.5 = dramatic)
//   breatheFreq: frequency of breathing (1.5 = calm, 4 = frantic)
//   pulseAmp: particle alpha oscillation amplitude (0 = steady, 0.4 = normal, 0.7 = intense)
//   pulseFreq: particle alpha oscillation frequency (2 = calm, 6 = fast)
//   glowRadius: multiplier on ambient glow radius (1 = default)
//   glowAlpha: multiplier on ambient glow opacity (1 = default)
//   radiusPulse: additive radius oscillation magnitude (0 = none)

interface EnergyProfile {
  orbitSpeed: number
  breatheAmp: number
  breatheFreq: number
  pulseAmp: number
  pulseFreq: number
  glowRadius: number
  glowAlpha: number
  radiusPulse: number
}

const DEFAULT_ENERGY: EnergyProfile = {
  orbitSpeed: 1, breatheAmp: 0.2, breatheFreq: 1.5,
  pulseAmp: 0.4, pulseFreq: 2, glowRadius: 1, glowAlpha: 1, radiusPulse: 0,
}

const ENERGY_PROFILES: Record<string, Partial<EnergyProfile>> = {
  // Processing: intense — fast orbits, strong breathing, bright glow, pulsing radius
  processing:     { orbitSpeed: 2.5, breatheAmp: 0.45, breatheFreq: 4, pulseAmp: 0.7, pulseFreq: 5, glowRadius: 1.4, glowAlpha: 1.6, radiusPulse: 3 },
  // Waiting tools: active — faster than idle, noticeable breathing
  waiting_tools:  { orbitSpeed: 1.8, breatheAmp: 0.35, breatheFreq: 3, pulseAmp: 0.55, pulseFreq: 4, glowRadius: 1.2, glowAlpha: 1.3, radiusPulse: 1.5 },
  // Starting/connecting: moderate activity
  starting:       { orbitSpeed: 1.5, breatheAmp: 0.3, breatheFreq: 2.5, pulseAmp: 0.5, pulseFreq: 3, glowRadius: 1.1, glowAlpha: 1.2, radiusPulse: 1 },
  connecting:     { orbitSpeed: 1.5, breatheAmp: 0.3, breatheFreq: 2.5, pulseAmp: 0.5, pulseFreq: 3, glowRadius: 1.1, glowAlpha: 1.2, radiusPulse: 1 },
  loading:        { orbitSpeed: 1.5, breatheAmp: 0.3, breatheFreq: 2.5, pulseAmp: 0.5, pulseFreq: 3, glowRadius: 1.1, glowAlpha: 1.2, radiusPulse: 1 },
  // Disabled/stopped: barely alive — slow, dim, no pulse
  disabled:       { orbitSpeed: 0.2, breatheAmp: 0.05, breatheFreq: 0.5, pulseAmp: 0.1, pulseFreq: 0.5, glowRadius: 0.5, glowAlpha: 0.3, radiusPulse: 0 },
  stopped:        { orbitSpeed: 0.2, breatheAmp: 0.05, breatheFreq: 0.5, pulseAmp: 0.1, pulseFreq: 0.5, glowRadius: 0.5, glowAlpha: 0.3, radiusPulse: 0 },
  disconnected:   { orbitSpeed: 0.2, breatheAmp: 0.05, breatheFreq: 0.5, pulseAmp: 0.1, pulseFreq: 0.5, glowRadius: 0.5, glowAlpha: 0.3, radiusPulse: 0 },
  // Error: erratic flicker
  error:          { orbitSpeed: 2, breatheAmp: 0.4, breatheFreq: 6, pulseAmp: 0.7, pulseFreq: 8, glowRadius: 1.3, glowAlpha: 1.5, radiusPulse: 2 },
  auth_required:  { orbitSpeed: 1.2, breatheAmp: 0.3, breatheFreq: 3, pulseAmp: 0.5, pulseFreq: 4, glowRadius: 1.1, glowAlpha: 1.2, radiusPulse: 1 },
}

function getEnergy(status: string): EnergyProfile {
  const override = ENERGY_PROFILES[status]
  if (!override) return DEFAULT_ENERGY
  return { ...DEFAULT_ENERGY, ...override }
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

  // Prune stale caches
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
    const e = getEnergy(status)
    const isRoot = node.parentId === null
    const isHovered = node.id === hoveredId
    const label = nodeLabels.get(node.id) ?? node.id

    let r = node.radius
    if (e.radiusPulse > 0) {
      r += Math.sin(t * 3) * e.radiusPulse
    }
    if (isHovered) r += 2

    ctx.globalAlpha = node.alpha

    // ── Ambient glow ──
    const glowR = r * 2.8 * e.glowRadius
    ctx.globalAlpha = node.alpha * 0.3 * e.glowAlpha
    const ag = ctx.createRadialGradient(node.x, node.y, r * 0.2, node.x, node.y, glowR)
    ag.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.4)`)
    ag.addColorStop(1, 'transparent')
    ctx.fillStyle = ag
    ctx.beginPath()
    ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2)
    ctx.fill()

    // ── Orbiting particles ──
    const swarm = getSwarm(node.id, r, isRoot)
    for (const p of swarm) {
      const a = p.angle + t * p.speed * e.orbitSpeed
      const breathe = 1 + e.breatheAmp * Math.sin(t * e.breatheFreq + p.phase)
      const d = p.orbitRadius * breathe
      const px = node.x + Math.cos(a) * d
      const py = node.y + Math.sin(a) * d

      const pulseAlpha = 0.5 + e.pulseAmp * Math.sin(t * e.pulseFreq + p.phase)
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

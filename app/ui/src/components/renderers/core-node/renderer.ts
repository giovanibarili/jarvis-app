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
// Controls visual intensity per status: speed, glow, breathing, pulse, radius.

interface StatusEnergy {
  speedMultiplier: number    // orbital speed multiplier (1.0 = normal)
  glowIntensity: number      // ambient glow alpha multiplier (1.0 = normal)
  glowSpread: number         // ambient glow radius multiplier (1.0 = normal)
  breatheAmplitude: number   // orbit breathing amplitude (0.2 = normal)
  breatheSpeed: number       // breathing frequency multiplier (1.0 = normal)
  pulseAlphaBase: number     // base particle alpha (0.5 = normal)
  pulseAlphaRange: number    // particle alpha oscillation range (0.4 = normal)
  pulseSpeed: number         // particle pulse frequency multiplier (1.0 = normal)
  radiusBoost: number        // additive radius (0 = none)
  radiusPulseAmp: number     // radius oscillation amplitude (0 = none)
  radiusPulseSpeed: number   // radius oscillation frequency (0 = none)
  wispSpeed: number          // edge wisp travel speed multiplier (1.0 = normal)
  coreAlpha: number          // core point alpha multiplier (1.0 = normal)
}

const DEFAULT_ENERGY: StatusEnergy = {
  speedMultiplier: 1.0,
  glowIntensity: 1.0,
  glowSpread: 1.0,
  breatheAmplitude: 0.2,
  breatheSpeed: 1.0,
  pulseAlphaBase: 0.5,
  pulseAlphaRange: 0.4,
  pulseSpeed: 1.0,
  radiusBoost: 0,
  radiusPulseAmp: 0,
  radiusPulseSpeed: 0,
  wispSpeed: 1.0,
  coreAlpha: 1.0,
}

const STATUS_ENERGY: Record<string, Partial<StatusEnergy>> = {
  // Calm, serene — slow particles, gentle glow
  online: {
    speedMultiplier: 0.7,
    glowIntensity: 0.8,
    breatheAmplitude: 0.15,
    breatheSpeed: 0.7,
    pulseAlphaBase: 0.4,
    pulseAlphaRange: 0.25,
    pulseSpeed: 0.6,
    wispSpeed: 0.7,
  },
  // High energy — fast particles, strong glow, pulsing radius
  processing: {
    speedMultiplier: 2.2,
    glowIntensity: 1.8,
    glowSpread: 1.3,
    breatheAmplitude: 0.35,
    breatheSpeed: 2.0,
    pulseAlphaBase: 0.6,
    pulseAlphaRange: 0.4,
    pulseSpeed: 2.5,
    radiusBoost: 2,
    radiusPulseAmp: 2.5,
    radiusPulseSpeed: 3.0,
    wispSpeed: 2.0,
    coreAlpha: 1.3,
  },
  // Anticipation — medium speed, subtle intermittent glow
  waiting_tools: {
    speedMultiplier: 1.4,
    glowIntensity: 1.2,
    glowSpread: 1.1,
    breatheAmplitude: 0.25,
    breatheSpeed: 1.3,
    pulseAlphaBase: 0.35,
    pulseAlphaRange: 0.5,
    pulseSpeed: 1.8,
    radiusPulseAmp: 1.0,
    radiusPulseSpeed: 1.5,
    wispSpeed: 1.3,
  },
  // Accelerating — building up
  loading: {
    speedMultiplier: 1.6,
    glowIntensity: 1.0,
    breatheAmplitude: 0.3,
    breatheSpeed: 1.8,
    pulseAlphaBase: 0.4,
    pulseAlphaRange: 0.45,
    pulseSpeed: 2.0,
    radiusPulseAmp: 1.5,
    radiusPulseSpeed: 2.0,
    wispSpeed: 1.5,
  },
  initializing: {
    speedMultiplier: 1.6,
    glowIntensity: 1.0,
    breatheAmplitude: 0.3,
    breatheSpeed: 1.8,
    pulseAlphaBase: 0.4,
    pulseAlphaRange: 0.45,
    pulseSpeed: 2.0,
    radiusPulseAmp: 1.5,
    radiusPulseSpeed: 2.0,
    wispSpeed: 1.5,
  },
  starting: {
    speedMultiplier: 1.5,
    glowIntensity: 1.1,
    breatheAmplitude: 0.28,
    breatheSpeed: 1.6,
    pulseSpeed: 1.8,
    wispSpeed: 1.4,
  },
  connecting: {
    speedMultiplier: 1.5,
    glowIntensity: 1.1,
    breatheAmplitude: 0.28,
    breatheSpeed: 1.6,
    pulseSpeed: 1.8,
    wispSpeed: 1.4,
  },
  // Normal running — same as default, slightly lively
  running: {
    speedMultiplier: 1.0,
    glowIntensity: 1.0,
  },
  connected: {
    speedMultiplier: 1.0,
    glowIntensity: 1.0,
  },
  // Dormant — barely moving, dim
  idle: {
    speedMultiplier: 0.3,
    glowIntensity: 0.4,
    glowSpread: 0.8,
    breatheAmplitude: 0.08,
    breatheSpeed: 0.4,
    pulseAlphaBase: 0.25,
    pulseAlphaRange: 0.15,
    pulseSpeed: 0.3,
    wispSpeed: 0.3,
    coreAlpha: 0.6,
  },
  // Stopped — nearly invisible, minimal motion
  stopped: {
    speedMultiplier: 0.1,
    glowIntensity: 0.2,
    glowSpread: 0.6,
    breatheAmplitude: 0.04,
    breatheSpeed: 0.2,
    pulseAlphaBase: 0.15,
    pulseAlphaRange: 0.1,
    pulseSpeed: 0.15,
    wispSpeed: 0.1,
    coreAlpha: 0.35,
  },
  disconnected: {
    speedMultiplier: 0.1,
    glowIntensity: 0.2,
    glowSpread: 0.6,
    breatheAmplitude: 0.04,
    breatheSpeed: 0.2,
    pulseAlphaBase: 0.15,
    pulseAlphaRange: 0.1,
    pulseSpeed: 0.15,
    wispSpeed: 0.1,
    coreAlpha: 0.35,
  },
  // Alert — erratic, fast pulsing, trembling
  error: {
    speedMultiplier: 2.5,
    glowIntensity: 2.0,
    glowSpread: 1.4,
    breatheAmplitude: 0.45,
    breatheSpeed: 3.0,
    pulseAlphaBase: 0.5,
    pulseAlphaRange: 0.5,
    pulseSpeed: 4.0,
    radiusPulseAmp: 3.0,
    radiusPulseSpeed: 5.0,
    wispSpeed: 2.5,
    coreAlpha: 1.4,
  },
  offline: {
    speedMultiplier: 2.0,
    glowIntensity: 1.6,
    glowSpread: 1.2,
    breatheAmplitude: 0.4,
    breatheSpeed: 2.5,
    pulseAlphaBase: 0.45,
    pulseAlphaRange: 0.5,
    pulseSpeed: 3.5,
    radiusPulseAmp: 2.5,
    radiusPulseSpeed: 4.0,
    wispSpeed: 2.0,
    coreAlpha: 1.2,
  },
  auth_required: {
    speedMultiplier: 1.8,
    glowIntensity: 1.4,
    glowSpread: 1.1,
    breatheAmplitude: 0.35,
    breatheSpeed: 2.0,
    pulseAlphaBase: 0.4,
    pulseAlphaRange: 0.5,
    pulseSpeed: 3.0,
    radiusPulseAmp: 2.0,
    radiusPulseSpeed: 3.5,
    wispSpeed: 1.8,
    coreAlpha: 1.1,
  },
}

function getEnergy(status: string): StatusEnergy {
  const overrides = STATUS_ENERGY[status]
  if (!overrides) return DEFAULT_ENERGY
  return { ...DEFAULT_ENERGY, ...overrides }
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

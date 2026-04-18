// core-node/physics.ts
// Lightweight force-directed simulation for the hud-core-node graph.
// No dependencies — pure math.

export interface PhysicsNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  parentId: string | null;
  /** Node radius — root is larger */
  radius: number;
  /** Fade alpha for enter/exit animations (0→1) */
  alpha: number;
  /** Target alpha (1 = alive, 0 = dying) */
  targetAlpha: number;
  /** When true, node position is controlled externally (drag). Physics skips it. */
  pinned: boolean;
}

export interface PhysicsEdge {
  sourceId: string;
  targetId: string;
}

const SPRING_LENGTH = 150;
const SPRING_STRENGTH = 0.03;
const REPULSION = 5000;
const CENTER_GRAVITY = 0.008;
const DAMPING = 0.85;
const ALPHA_SPEED = 0.06;
const MIN_VELOCITY = 0.01;

export class ForceSimulation {
  nodes = new Map<string, PhysicsNode>();
  edges: PhysicsEdge[] = [];
  private cx = 0;
  private cy = 0;
  settled = false;

  setCenter(x: number, y: number) {
    this.cx = x;
    this.cy = y;
  }

  /**
   * Sync the simulation with a new tree snapshot.
   * New nodes get spawned near their parent; removed nodes fade out.
   */
  sync(tree: Array<{ id: string; parentId: string | null; label: string; status: string }>) {
    const newIds = new Set(tree.map(n => n.id));

    // Mark removed nodes for fade-out
    for (const node of this.nodes.values()) {
      if (!newIds.has(node.id)) {
        node.targetAlpha = 0;
      }
    }

    // Add or update nodes
    for (const n of tree) {
      let node = this.nodes.get(n.id);
      if (!node) {
        // Spawn near parent or center
        const parent = n.parentId ? this.nodes.get(n.parentId) : null;
        const bx = parent ? parent.x : this.cx;
        const by = parent ? parent.y : this.cy;
        const angle = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 40;
        node = {
          id: n.id,
          x: bx + Math.cos(angle) * dist,
          y: by + Math.sin(angle) * dist,
          vx: 0,
          vy: 0,
          parentId: n.parentId,
          radius: n.parentId === null ? 50 : 8,
          alpha: 0,
          targetAlpha: 1,
          pinned: false,
        };
        this.nodes.set(n.id, node);
        this.settled = false;
      } else {
        node.parentId = n.parentId;
        node.targetAlpha = 1;
        node.radius = n.parentId === null ? 50 : 8;
      }
    }

    // Rebuild edges
    this.edges = tree
      .filter(n => n.parentId !== null)
      .map(n => ({ sourceId: n.parentId!, targetId: n.id }));

    // Purge fully faded nodes
    for (const [id, node] of this.nodes) {
      if (node.alpha <= 0.01 && node.targetAlpha === 0) {
        this.nodes.delete(id);
      }
    }
  }

  /**
   * Advance one simulation frame. Returns true if still moving.
   */
  tick(): boolean {
    const nodes = [...this.nodes.values()];
    if (nodes.length === 0) return false;

    // ── Forces ──
    for (const node of nodes) {
      if (node.pinned) continue;

      if (node.parentId === null) {
        // Root: strong pull to center
        node.vx += (this.cx - node.x) * 0.1;
        node.vy += (this.cy - node.y) * 0.1;
        continue;
      }

      // Center gravity (weak)
      node.vx += (this.cx - node.x) * CENTER_GRAVITY;
      node.vy += (this.cy - node.y) * CENTER_GRAVITY;
    }

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (a.parentId !== null && !a.pinned) { a.vx -= fx; a.vy -= fy; }
        if (b.parentId !== null && !b.pinned) { b.vx += fx; b.vy += fy; }
      }
    }

    // Spring attraction along edges
    for (const edge of this.edges) {
      const source = this.nodes.get(edge.sourceId);
      const target = this.nodes.get(edge.targetId);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const displacement = dist - SPRING_LENGTH;
      const force = displacement * SPRING_STRENGTH;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (source.parentId !== null && !source.pinned) { source.vx += fx; source.vy += fy; }
      if (target.parentId !== null && !target.pinned) { target.vx -= fx; target.vy -= fy; }
    }

    // Apply velocity + damping
    let maxVel = 0;
    for (const node of nodes) {
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
      const vel = Math.abs(node.vx) + Math.abs(node.vy);
      if (vel > maxVel) maxVel = vel;

      // Animate alpha
      const alphaDiff = node.targetAlpha - node.alpha;
      if (Math.abs(alphaDiff) > 0.01) {
        node.alpha += alphaDiff * ALPHA_SPEED;
        maxVel = Math.max(maxVel, Math.abs(alphaDiff));
      } else {
        node.alpha = node.targetAlpha;
      }
    }

    this.settled = maxVel < MIN_VELOCITY;
    return !this.settled;
  }
}

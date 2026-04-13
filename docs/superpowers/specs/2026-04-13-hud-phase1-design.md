# HUD Phase 1: Data-Driven Reactor Mind-Map

**Date:** 2026-04-13
**Status:** Approved
**Project:** JARVIS App

## Overview

The HUD is a stateless renderer of a `HudState` defined by the backend. The Jarvis Lead controls everything: which nodes to show, which layout to use, which panels to display. The frontend has zero business logic — it renders what it receives.

This makes the HUD fully controllable by the LLM at runtime: change layout, show/hide panels, expand nodes, change colors, add alerts — all via data, no code changes.

## HudState Contract

The `/hud` endpoint returns the complete interface state. The frontend polls every 2 seconds.

```typescript
type HudNode = {
  id: string;
  label: string;
  value: string;
  color: string;
  children?: HudNode[];
  expanded?: boolean;
  pulse?: boolean;
};

type HudPanel = {
  id: string;
  type: "chat" | "logs" | "custom";
  visible: boolean;
  position: "bottom" | "right" | "overlay";
  size?: "sm" | "md" | "lg";
};

type HudState = {
  layout: string;
  reactor: {
    status: string;
    coreLabel: string;
    coreSubLabel: string;
  };
  nodes: HudNode[];
  panels: HudPanel[];
};
```

## Backend Changes

### Jarvis: `getHudState()`

Replaces `getStatus()` and `getMetrics()`. Builds the full HudState from internal state. Phase 1 defaults:

```typescript
getHudState(): HudState {
  return {
    layout: "center-chat-bottom",
    reactor: {
      status: this.state,
      coreLabel: this.state.toUpperCase(),
      coreSubLabel: formatUptime(this.uptime),
    },
    nodes: [
      { id: "queue", label: "QUEUE", value: String(this.queue.size), color: "#4af", children: [] },
      { id: "actors", label: "ACTORS", value: String(this.actorPool.size), color: "#a6f", children: [] },
      { id: "response", label: "RESP", value: `${this.lastResponseTimeMs}ms`, color: this.lastResponseTimeMs > 5000 ? "#fa4" : "#4a4", children: [] },
      { id: "uptime", label: "UP", value: formatUptime(this.uptime), color: "#4af", children: [] },
    ],
    panels: [
      { id: "chat", type: "chat", visible: true, position: "bottom", size: "md" },
      { id: "logs", type: "logs", visible: false, position: "bottom", size: "sm" },
    ],
  };
}
```

### HTTP Server

- Add `/hud` endpoint returning `jarvis.getHudState()`
- Keep `/chat` endpoint (POST)
- Keep `/logs` endpoint (SSE)
- Remove `/status` and `/metrics` (absorbed into `/hud`)

## Frontend Components

### File Structure

```
ui/src/
  App.tsx                        — fetch /hud, pass HudState to renderer
  styles.css                     — global styles, fonts
  components/
    HudRenderer.tsx              — layout dispatcher based on HudState.layout
    ReactorCore.tsx              — SVG arc reactor with status animation
    MindMapNodes.tsx             — radial nodes around reactor, supports children + expansion
    PanelRenderer.tsx            — renders visible panels by position
    panels/
      ChatPanel.tsx              — chat input/output (extracted from ChatBox)
      LogPanel.tsx               — SSE log viewer (existing, minor refactor)
```

### ReactorCore

SVG component. Concentric rings with rotation animations. Core circle with radial gradient glow. `reactor.status` drives:
- Color: online=#4af, processing=#fa4, loading=#a6f, offline=#f44
- Animation: online=slow pulse, processing=fast pulse+ring spin, loading=medium pulse+ring spin, offline=dim static

Core displays `reactor.coreLabel` (e.g., "ONLINE") and `reactor.coreSubLabel` (e.g., "00:14:32").

### MindMapNodes

Renders `nodes[]` at cardinal positions around the reactor (top, right, bottom, left for 4 nodes; evenly spaced for N nodes). Each node:
- Thin line from reactor edge to label position
- Label text (small, uppercase, monospace)
- Value text (larger, colored)
- If `pulse: true`: glow animation on the value
- If `expanded: true` and `children[]`: render sub-nodes at a larger radius connected to the parent node

Positions calculated as: `angle = (index / total) * 2π - π/2` (starting from top), `x = cx + cos(angle) * radius`, `y = cy + sin(angle) * radius`.

### PanelRenderer

Maps `panels[]` to rendered components by `type`. Respects `visible`, `position`, and `size`. Chat panel has a toggle button always visible. Logs panel toggled via a small icon.

### HudRenderer

Dispatches layout. For Phase 1, only `"center-chat-bottom"`:
- ReactorCore + MindMapNodes in the top 65% of the window
- Visible panels in the bottom 35%

Future layouts can rearrange the same components differently.

## Fonts

Import via Google Fonts in `index.html` or `styles.css`:
- **Orbitron** — sci-fi headings, labels, node text
- **JetBrains Mono** — data values, chat text, logs

## Electron Window

- Size: 800x600 (up from 750x550)
- Frame: false
- Transparent: true
- Always on top: true
- Draggable: entire window except panels (panels have `-webkit-app-region: no-drag`)

## Removed Components

These are replaced by the new data-driven architecture:
- `ArcReactor.tsx` → replaced by `ReactorCore.tsx`
- `MetricsPanel.tsx` → absorbed into `MindMapNodes.tsx`
- `GrpcStatus.tsx` → absorbed as a node in the mind-map
- `ChatBox.tsx` → refactored into `panels/ChatPanel.tsx`

## Default Phase 1 State

On startup, before the LLM has intelligence to adapt:
- Layout: `"center-chat-bottom"`
- Reactor: status-colored, pulsing
- 4 radial nodes: Queue (top), Actors (right), Response Time (bottom), Uptime (left)
- Chat panel: visible, bottom, medium size
- Logs panel: hidden, toggleable

## Future Extensions (not in scope)

- LLM dynamically adding/removing/expanding nodes at runtime
- Three.js upgrade for 3D reactor with energy shader
- Layout switching at runtime
- Custom panel types
- VoiceOrb integration when Kokoro TTS is wired
- Particle field background

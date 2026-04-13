# Component System Design

**Date:** 2026-04-13
**Status:** Approved
**Project:** JARVIS App

## Overview

A plugin-like architecture where every feature is a Component with full lifecycle management, dependency resolution, and optional HUD representation. Components can be started, stopped, and controlled by Jarvis at runtime. Config defines what starts on boot and what is permanent (cannot be disabled).

## Component Interface

```typescript
interface Component {
  id: string;
  name: string;
  dependencies: string[];
  permanent: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;

  getHudConfig(): HudComponentConfig | null;
  getData(): Record<string, unknown>;
  getStatus(): "running" | "stopped" | "starting" | "stopping" | "error";
}

type HudComponentConfig = {
  type: "panel" | "overlay" | "indicator";
  draggable: boolean;
  resizable: boolean;
};
```

Components with no UI return `null` from `getHudConfig()`. Components with UI declare their type and capabilities. Position and size are controlled by Jarvis, not the component.

## Components

| ID | Name | Permanent | StartOnBoot | Dependencies | HUD Type | Description |
|----|------|-----------|-------------|--------------|----------|-------------|
| `jarvis-core` | Jarvis Core | yes | yes | none | overlay | VoiceOrb + session + event loop + queue |
| `chat` | Chat | yes | yes | `jarvis-core` | panel | User conversation via queue |
| `grpc` | gRPC Server | no | no | `jarvis-core` | indicator | gRPC transport on port 50051 |
| `logs` | Log Viewer | no | no | none | panel | SSE log stream |
| `mind-map` | Mind Map | no | yes | `jarvis-core` | overlay | Radial metric nodes |

## ComponentRegistry

Manages all component lifecycles.

```typescript
class ComponentRegistry {
  register(component: Component): void;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  get(id: string): Component | undefined;
  getActive(): Component[];
  getAll(): Component[];
}
```

Behaviors:
- `start(id)` resolves dependencies first — starts them in topological order if not already running
- `stop(id)` checks dependents — refuses if an active component depends on it (unless that dependent is also being stopped)
- `stop(id)` on a permanent component throws an error
- State transitions are logged and published to the queue as system events
- Registry reads config on init to determine which components to auto-start

## Config

```typescript
type ComponentConfig = {
  startOnBoot: boolean;
  permanent: boolean;
};

// In config/index.ts
components: Record<string, ComponentConfig> = {
  "jarvis-core": { startOnBoot: true,  permanent: true },
  "chat":        { startOnBoot: true,  permanent: true },
  "grpc":        { startOnBoot: false, permanent: false },
  "logs":        { startOnBoot: false, permanent: false },
  "mind-map":    { startOnBoot: true,  permanent: false },
};
```

## HUD Integration

### HudState Contract (revised)

```typescript
type HudComponentState = {
  id: string;
  name: string;
  status: string;
  hudConfig: HudComponentConfig;
  position: { x: number; y: number };
  size: { width: number; height: number };
  data: Record<string, unknown>;
};

type HudState = {
  reactor: HudReactor;
  components: HudComponentState[];
};
```

Jarvis builds the HudState by iterating active components from the registry. For each component with a `getHudConfig() !== null`, Jarvis determines position and size and includes it in `components[]`. Jarvis controls all layout decisions.

The `data` field is component-specific: chat sends message count, gRPC sends port and connection count, mind-map sends the nodes array, logs sends nothing (SSE is separate).

### Frontend Rendering

The frontend has a renderer map:

```typescript
const renderers: Record<string, (state: HudComponentState) => ReactNode> = {
  "jarvis-core": (s) => <ReactorCore ... />,
  "chat":        (s) => <ChatPanel ... />,
  "grpc":        (s) => <GrpcIndicator ... />,
  "logs":        (s) => <LogPanel ... />,
  "mind-map":    (s) => <MindMapNodes ... />,
};
```

App iterates `state.components`, looks up the renderer by `id`, wraps in `DraggablePanel` with the position/size from state.

Unknown component IDs are ignored (forward compatibility).

## Lifecycle Flow

### Startup
1. Registry created
2. All components registered
3. Config read — components with `startOnBoot: true` queued
4. Topological sort by dependencies
5. Start in order: `jarvis-core` → `chat` → `mind-map`
6. Each start logged + published to queue

### Runtime Start (e.g., user asks "activate gRPC")
1. Jarvis calls `registry.start("grpc")`
2. Registry checks dependencies: `jarvis-core` — already running
3. gRPC component `start()` called — binds port
4. State transition logged + published
5. Next `getHudState()` call includes gRPC in components[]
6. Frontend renders gRPC indicator

### Runtime Stop (e.g., user asks "deactivate logs")
1. Jarvis calls `registry.stop("logs")`
2. Registry checks: not permanent, no active dependents
3. Logs component `stop()` called
4. State transition logged + published
5. Next `getHudState()` call excludes logs
6. Frontend removes logs panel

### Shutdown
1. SIGINT received
2. All active components stopped in reverse dependency order
3. `mind-map` → `chat` → `jarvis-core`

## File Structure

```
src/
  components/
    types.ts               — Component interface + HudComponentConfig
    registry.ts            — ComponentRegistry class
    jarvis-core.ts         — JarvisCore component (orb + session + queue + loop)
    chat.ts                — Chat component (produces to queue)
    grpc.ts                — gRPC transport component
    logs.ts                — Log viewer component
    mind-map.ts            — Mind map metrics component
  config/index.ts          — Updated with components config
  main.ts                  — Registers all components, starts via registry
ui/src/
  types/hud.ts             — Updated HudState with HudComponentState
  components/
    HudRenderer.tsx         — Iterates components[], renders via map
    DraggablePanel.tsx      — Wraps each component (existing)
    renderers/
      ReactorCoreRenderer.tsx
      ChatPanelRenderer.tsx
      GrpcIndicatorRenderer.tsx
      LogPanelRenderer.tsx
      MindMapRenderer.tsx
```

## Migration

The current code has functionality spread across `jarvis.ts`, `main.ts`, and individual transport files. The component system consolidates each into a self-contained unit. Jarvis class shrinks — it becomes the `jarvis-core` component. The queue, session, and actor pool move inside `jarvis-core`. Other transports become their own components.

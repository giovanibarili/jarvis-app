# JARVIS — Architecture

## Overview

JARVIS is an AI assistant built on a hexagonal (ports & adapters) architecture. The system is composed of independent **Pieces** that communicate exclusively through an **EventBus**. No piece knows about any other piece — they only know about the bus.

```
┌─────────────────────────────────────────────────────────────────┐
│                        EventBus (pub/sub)                       │
├────────┬──────────┬───────────┬──────────┬──────────┬───────────┤
│ Input  │   Core   │  Output   │  Tools   │   MCP    │    HUD    │
│ Pieces │  Pieces  │  Pieces   │  System  │  System  │  System   │
└────────┴──────────┴───────────┴──────────┴──────────┴───────────┘
```

## Core Concepts

### Piece

Every module implements the `Piece` interface (`src/core/piece.ts`):

```typescript
interface Piece {
  readonly id: string;
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}
```

Pieces are plug-and-play. They register themselves on the bus during `start()`, publish HUD representations, and clean up on `stop()`. The `PieceManager` (`src/core/piece-manager.ts`) handles lifecycle, runtime toggle, and settings persistence.

### EventBus

The central nervous system (`src/core/bus.ts`). Supports exact topic matching (`subscribe`) and wildcard patterns (`subscribePattern`). All communication is async fire-and-forget.

Topic convention: `<domain>.<scope>.<action>`

```
input.prompt              — user sends a message
core.main.stream.delta    — LLM streaming token
core.main.stream.complete — LLM finished responding
core.main.tool.request    — LLM wants to use tools
core.main.tool.result     — tool execution results
voice.audio.ready         — TTS audio generated
hud.piece.add/update/remove — HUD state changes
```

### BusMessage

Every message carries two identifiers:

- **sessionId** — shared conversation context (e.g. "main"). Multiple pieces can participate in the same session.
- **componentId** — the origin piece that published the message.

### Settings

`.jarvis/settings.json` persists piece state across restarts (`src/core/settings.ts`). Each piece has `enabled` (start/stop) and `visible` (show/hide in HUD) flags.

## Directory Structure

```
src/
├── ai/                    # AI provider abstraction
│   ├── types.ts           # AISession, ToolCall, ToolResult interfaces
│   └── anthropic/         # Anthropic Claude implementation
│       ├── factory.ts     # Creates sessions with system prompt + tools
│       └── session.ts     # Streaming API, tool results, message history
├── core/                  # System core
│   ├── bus.ts             # EventBus — pub/sub with wildcard patterns
│   ├── types.ts           # All event type definitions
│   ├── piece.ts           # Piece interface + HUD piece types
│   ├── piece-manager.ts   # Lifecycle, toggle, settings sync, tools
│   ├── settings.ts        # .jarvis/settings.json read/write
│   ├── jarvis.ts          # JarvisCore — state machine (idle→processing→waiting_tools)
│   ├── session-manager.ts # Per-sessionId AI session management
│   └── hud-state.ts       # Aggregates HUD piece events for /hud endpoint
├── input/                 # Input adapters (how users talk to JARVIS)
│   ├── chat-piece.ts      # HTTP chat — /chat/send, /chat-stream SSE
│   ├── grpc-piece.ts      # gRPC server piece with start/stop tools
│   └── grpc.ts            # gRPC input adapter (bus bridge)
├── output/                # Output adapters (how JARVIS talks back)
│   ├── voice-piece.ts     # TTS via Kokoro, streaming audio, voice/STT tools
│   └── token-counter.ts   # Tracks API token usage
├── tools/                 # Tool system
│   ├── registry.ts        # ToolRegistry — register, execute, list
│   ├── executor.ts        # ToolExecutor piece — bridges bus events to registry
│   └── loader.ts          # ToolLoaderPiece — loads JSON tool configs from tools/
├── mcp/                   # Model Context Protocol
│   ├── manager.ts         # McpManager piece — HTTP/SSE/stdio transports, OAuth
│   └── oauth.ts           # JarvisOAuthProvider — file-persisted tokens
├── transport/             # Transport layer
│   ├── grpc/              # gRPC server and client
│   ├── hud/electron.ts    # Electron window launcher with screenshot server
│   └── proto/jarvis.proto # gRPC service definition
├── logger/index.ts        # Pino logger with in-memory buffer
├── config/index.ts        # Environment-based configuration
├── server.ts              # HTTP server — routes to pieces
└── main.ts                # Composition root — wires everything together

tools/                     # Config-based tool definitions
├── bash.json              # Shell command execution
├── edit-file.json         # Find+replace in files
├── glob.json              # File pattern search
├── grep.json              # Content search with regex
├── list-dir.json          # Directory listing
├── read-file.json         # File reading (text/image/PDF)
├── write-file.json        # File writing
└── scripts/               # Shell scripts implementing the tools

ui/                        # React frontend (Vite)
├── src/
│   ├── App.tsx            # Polls /hud, renders HudRenderer
│   ├── hud.css            # CSS custom properties + shared classes
│   ├── components/
│   │   ├── HudRenderer.tsx    # Main layout — orb center, panels around
│   │   ├── ReactorCore.tsx    # Central orb with status-reactive animations
│   │   ├── MiniOrb.tsx        # Smaller orb for voice pieces (3 states: idle/ready/reacting)
│   │   ├── DraggablePanel.tsx # react-rnd wrapper for all panels
│   │   ├── panels/           # Panel content components
│   │   │   ├── ChatOutput.tsx  # SSE streaming messages
│   │   │   ├── ChatInput.tsx   # Text input
│   │   │   ├── VoiceOutput.tsx # TTS playback with audio-reactive orb
│   │   │   └── VoiceInput.tsx  # Silero VAD + Whisper STT with audio-reactive orb
│   │   └── renderers/        # Maps piece IDs to React components
│   └── types/hud.ts       # HUD state types
└── public/vad/            # Silero VAD ONNX model + WASM runtime
```

## Data Flow

### Text conversation

```
User types in ChatInput
  → POST /chat/send
  → ChatPiece publishes input.prompt to bus
  → JarvisCore subscribes, sends to Anthropic API (streaming)
  → Publishes core.main.stream.delta (each token)
  → ChatPiece broadcasts to SSE clients
  → ChatOutput renders in real-time
  → On complete: core.main.stream.complete
  → VoicePiece generates TTS audio
  → Publishes voice.audio.ready
  → VoiceOutput plays audio with reactive orb
```

### Tool execution

```
Anthropic API returns tool_use
  → JarvisCore publishes core.main.tool.request
  → ToolExecutor subscribes, calls ToolRegistry.execute()
  → ToolRegistry runs the handler (script, MCP, or built-in)
  → ToolExecutor publishes core.main.tool.result
  → JarvisCore continues the conversation with tool results
```

### Voice input

```
User clicks mic orb (VoiceInput)
  → Silero VAD monitors microphone
  → onSpeechEnd fires with Float32Array audio
  → Converts to WAV, sends to Whisper (localhost:50055)
  → Whisper returns transcription
  → POST /chat/send with transcribed text
  → Same flow as text conversation
```

## Ports

| Port | Service | Configurable |
|------|---------|-------------|
| 50051 | gRPC Server | `JARVIS_GRPC_PORT` |
| 50052 | HTTP Server (chat, HUD, static) | hardcoded in main.ts |
| 50053 | Electron screenshot server | hardcoded in electron.ts |
| 50054 | Voice audio server | `JARVIS_VOICE_PORT` |
| 50055 | Whisper STT (external) | hardcoded in VoiceInput.tsx |
| 8880 | Kokoro TTS (external) | `JARVIS_TTS_URL` |

## Adding a New Piece

1. Create `src/<domain>/my-piece.ts` implementing `Piece`
2. In `start(bus)`: subscribe to events, publish HUD piece via `hud.piece.add`
3. In `stop()`: publish `hud.piece.remove`, clean up
4. Register in `src/main.ts` pieces array
5. Create `ui/src/components/renderers/MyPieceRenderer.tsx`
6. Add to `ui/src/components/renderers/index.ts`

## Adding a New Tool

Config-based (no code):
1. Create `tools/my-tool.json` with name, description, command, args, input_schema
2. Create `tools/scripts/my-tool.sh` implementing the logic
3. Use `__TYPE__:text/error/image` protocol for output
4. Restart JARVIS — ToolLoaderPiece auto-loads it

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `JARVIS_MODEL` | claude-sonnet-4-6 | Claude model to use |
| `JARVIS_GRPC_PORT` | 50051 | gRPC server port |
| `JARVIS_GRPC_ENABLED` | true | Enable gRPC on boot |
| `JARVIS_TTS_URL` | http://localhost:8880 | Kokoro TTS server URL |
| `JARVIS_TTS_MODEL` | kokoro | TTS model name |
| `JARVIS_TTS_VOICE` | bm_george | Default TTS voice |
| `JARVIS_TTS_ENABLED` | true | Enable TTS on boot |
| `JARVIS_VOICE_PORT` | 50054 | Voice audio server port |
| `JARVIS_STT_LANG` | auto | Default STT language |
| `JARVIS_DISPLAY` | auto | Electron display index |
| `JARVIS_SYSTEM_PROMPT` | ./jarvis.md | System prompt file path |
| `LOG_LEVEL` | info | Log level (debug, info, warn, error) |

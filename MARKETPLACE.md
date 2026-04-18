# JARVIS Plugin Marketplace

Available plugins for JARVIS. Install any plugin by asking JARVIS:

```
"Install the voice plugin from github.com/giovanibarili/jarvis-plugin-voice"
```

Or use the tool directly: `plugin_install` with the repo URL.

## Plugins

### Voice I/O

Real-time text-to-speech and speech-to-text. TTS via Kokoro with streaming audio pipeline, STT via Whisper for voice input. The HUD panel shows a morphing orb that changes color based on state (blue=online, green=speaking, red=TTS offline). Supports multiple voice categories (American, British, Portuguese — male/female).

**Repo:** [github.com/giovanibarili/jarvis-plugin-voice](https://github.com/giovanibarili/jarvis-plugin-voice)

**Provides:** VoicePiece (backend), VoiceRenderer (HUD panel), 3 tools (voice_set, voice_list, voice_toggle)

**Requires:** Kokoro TTS on port 8880 — [Voicebox app](https://voicebox.sh/) or [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)

### Actor Pool

Persistent AI actor pool for autonomous task delegation. Create named actors with roles (generic, researcher, coder, reviewer, and custom roles from `~/.jarvis/roles/*.md`) that maintain conversation memory across tasks. Actors execute autonomously with full tool access and report results back to the caller session. Direct actor chat via SSE streaming. HUD panel with create/kill buttons, status indicators, and actor status reporting.

**Repo:** [github.com/giovanibarili/jarvis-plugin-actors](https://github.com/giovanibarili/jarvis-plugin-actors)

**Provides:** ActorPoolPiece (lifecycle/tools/HUD), ActorRunnerPiece (task execution), ActorChatPiece (HTTP routes/SSE), 5 tools (actor_dispatch, actor_list, actor_kill, actor_status, bus_publish)

**Requires:** Nothing — uses JARVIS AI sessions via PluginContext

### Skill System

Extensible procedural knowledge loaded on demand. Create skills as `SKILL.md` files in `~/.jarvis/skills/` with YAML frontmatter (name, description, triggers) and markdown instruction body. The plugin discovers them, shows a catalog in the system prompt, and loads full instructions only when invoked. Three invocation paths: AI auto-invoke (trigger matching), slash commands (`/skill-name [args]`), or direct tool call. Skills with `context: fork` dispatch to isolated actors instead of injecting into the current session. Per-session isolation, token budgets, and hot-reload on file changes.

**Repo:** [github.com/giovanibarili/jarvis-plugin-skills](https://github.com/giovanibarili/jarvis-plugin-skills)

**Provides:** SkillManagerPiece (discovery/activation/hot-reload), 3 tools (skill_invoke, skill_deactivate, skill_list), slash commands per skill

**Requires:** Nothing — reads `~/.jarvis/skills/` directory

### Memory Palace

Persistent semantic memory powered by MemPalace + ChromaDB. Memories are organized hierarchically into Wings → Rooms → Drawers (e.g. user/preferences, jarvis/decisions, codebase/errors). Supports auto-save on context compaction and idle inactivity, auto-recall at session start, and semantic search across all stored memories. Each actor gets its own room in the `actors` wing.

**Repo:** [github.com/ataide25/jarvis-plugin-memory](https://github.com/ataide25/jarvis-plugin-memory)

**Provides:** MemoryPalacePiece (backend + auto-save/recall), MemoryRenderer (HUD panel), 5 tools (memory_search, memory_add, memory_delete, memory_list, memory_stats)

**Requires:** ChromaDB running locally (default port 8000) — [chromadb.dev](https://www.trychroma.com/)

### Canvas

Visual canvas with two tab types: Mermaid diagrams and freehand drawing. The AI can create diagrams programmatically (flowchart, sequence, class, state, ER, gantt, pie, etc.) and draw SVG elements. The user can freehand draw with perfect-freehand strokes, add text labels, erase, pan/zoom on an infinite canvas, and send drawings back to the AI as PNG images for visual collaboration. Dark theme, tab-based UI.

**Repo:** local — `~/.jarvis/plugins/jarvis-plugin-canvas/`

**Provides:** CanvasPiece (backend + HTTP route for send), CanvasRenderer (HUD panel), 4 tools (canvas_mermaid, canvas_draw, canvas_add, canvas_clear)

**Requires:** Nothing — mermaid and perfect-freehand bundled as npm dependencies

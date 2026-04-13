# JARVIS Plugin Marketplace

Available plugins for JARVIS. Install any plugin by asking JARVIS:

```
"Install the voice plugin from github.com/giovanibarili/jarvis-plugin-voice"
```

Or use the tool directly: `plugin_install` with the repo URL.

## Plugins

### Voice Output

Real-time text-to-speech via Kokoro TTS. JARVIS speaks every response through a streaming audio pipeline. The HUD panel shows a morphing orb that changes color based on state (blue=online, green=speaking, red=TTS offline). Auto-starts Kokoro if installed locally.

**Repo:** [github.com/giovanibarili/jarvis-plugin-voice](https://github.com/giovanibarili/jarvis-plugin-voice)

**Provides:** VoicePiece (backend), VoiceRenderer (HUD panel), 3 tools (voice_set, voice_list, voice_toggle)

**Requires:** Kokoro TTS on port 8880 — [Voicebox app](https://voicebox.sh/) or [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)

### Actor Pool

Persistent AI actor pool for autonomous task delegation. Create named actors with roles (generic, researcher, coder, reviewer) that maintain conversation memory across tasks. Actors execute autonomously with tool access and report results back to the main session. Direct actor chat via SSE streaming on the main HTTP server.

**Repo:** [github.com/giovanibarili/jarvis-plugin-actors](https://github.com/giovanibarili/jarvis-plugin-actors)

**Provides:** ActorPoolPiece (lifecycle/tools/HUD), ActorRunnerPiece (task execution), ActorChatPiece (HTTP routes/SSE), 4 tools (actor_dispatch, actor_list, actor_kill, bus_publish)

**Requires:** Nothing — uses JARVIS AI sessions via PluginContext

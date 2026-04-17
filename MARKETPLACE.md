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

### Skill System

Claude Code-style `SKILL.md` files with per-session isolation, context forking, and token budgets. Create skills as markdown files in `~/.jarvis/skills/` — the plugin discovers them, shows a catalog in the system prompt, and loads full instructions only when invoked. Three invocation paths: AI auto-invoke (trigger matching), slash commands (`/skill-name`), or direct tool call. Skills with `context: fork` dispatch to isolated actors instead of injecting into the current session.

**Repo:** [github.com/giovanibarili/jarvis-plugin-skills](https://github.com/giovanibarili/jarvis-plugin-skills)

**Provides:** SkillManagerPiece (discovery/activation/hot-reload), 3 tools (skill_invoke, skill_deactivate, skill_list), slash commands per skill

**Requires:** Nothing — reads `~/.jarvis/skills/` directory

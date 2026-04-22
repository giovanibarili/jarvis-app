# JARVIS Core — Functional Tests

> BDD scenarios for validating the JARVIS runtime end-to-end.
> Execute these after any code change, dependency update, or architecture refactor.

## Feature: Startup & Initialization

### Scenario: Clean boot with all core pieces loaded

```gherkin
Given JARVIS is installed with default settings
When the process starts
Then piece_list should show all core pieces:
  | Piece              | Running | Protected |
  | jarvis-core        | true    | true      |
  | capability-executor| true    | true      |
  | capability-loader  | true    | true      |
  | chat               | true    | true      |
  | hud-core-node      | true    | false     |
  | cron               | true    | false     |
  | plugin-manager     | true    | false     |
  | grpc               | true    | false     |
  | diff-viewer        | true    | false     |
And GET /hud should return a JSON with reactor.status "online"
And GET /hud should return components for all visible pieces
And the HUD Electron window should render without errors
```

### Scenario: Disabled piece is skipped on boot

```gherkin
Given settings.user.json has mcp-manager with enabled: false
When JARVIS boots
Then piece_list should show mcp-manager as enabled: false, running: false
And the graph registry should show mcp-manager with status "disabled"
```

### Scenario: Startup prompt is delivered on boot

```gherkin
Given a file exists at .jarvis/startup-prompt.txt with content "Testing startup"
When JARVIS boots
Then the startup prompt should be consumed (file deleted)
And the main session should receive a [SYSTEM] message containing the prompt
And the AI should process it as informational context (not execute it as a command)
```

### Scenario: Conversation history is restored on restart

```gherkin
Given JARVIS has processed at least 3 messages in the main session
When JARVIS is restarted (jarvis_reset)
Then the main session should restore previous message history
And the AI should have memory of the previous conversation
```

## Feature: AI Request/Response Cycle

### Scenario: Simple text prompt

```gherkin
Given JARVIS is online with the main session idle
When a user sends "What is 2+2?" via POST /chat/send
Then the session state should transition: online → processing → online
And the HUD reactor should reflect each state transition
And the chat should display a response containing "4"
And the token counter should update with input/output token counts
```

### Scenario: Prompt triggers tool use

```gherkin
Given JARVIS is online
When a user sends "List the files in the current directory"
Then the session state should transition: online → processing → waiting_tools → processing → online
And the chat should show a tool execution bar for "list_dir"
And the tool result should be incorporated into the final response
And the response should contain file names from the working directory
```

### Scenario: Multi-tool response

```gherkin
Given JARVIS is online
When a user sends a prompt that requires multiple independent tool calls
Then all tools should execute in parallel (single capability.request with multiple calls)
And each tool should emit tool_start and tool_done events on ai.stream
And the final response should synthesize results from all tools
```

### Scenario: Abort during processing

```gherkin
Given JARVIS is processing a prompt (state = processing or waiting_tools)
When the user sends POST /chat/abort
Then the current operation should be cancelled
And an "aborted" event should be emitted on ai.stream
And the session should return to "idle" state
And the HUD reactor should show "ONLINE"
```

### Scenario: Queued prompts are drained after completion

```gherkin
Given JARVIS is processing a prompt (state = processing)
When a second prompt arrives via ai.request
Then the second prompt should be queued (not abort the first)
And when the first prompt completes, the queued prompt should be processed automatically
```

## Feature: Pieces — Lifecycle & Graph

### Scenario: All pieces appear in the core node graph

```gherkin
Given JARVIS is running with all default pieces started
When graphRegistry.getTree() is called
Then the tree should contain a root node "jarvis-core"
And every running piece should appear as a child of "jarvis-core" with status "running"
And disabled pieces should appear with status "disabled"
And the tree should NOT contain any hardcoded plugin-specific nodes
```

Verify with:
```
jarvis_eval('const gr = (await import("./core/graph-registry.js")).graphRegistry; return JSON.stringify(gr.getTree())')
```

### Scenario: Enable a disabled piece

```gherkin
Given mcp-manager is disabled in settings
When piece_enable("mcp-manager") is called
Then piece_list should show mcp-manager as enabled: true, running: true
And settings.user.json should have mcp-manager.enabled = true
And the graph registry should show mcp-manager with status "running"
```

### Scenario: Disable a non-protected piece

```gherkin
Given cron is running
When piece_disable("cron") is called
Then piece_list should show cron as enabled: false, running: false
And settings.user.json should have cron.enabled = false
And the graph registry should show cron with status "disabled"
```

### Scenario: Cannot disable a protected piece

```gherkin
Given jarvis-core is running
When piece_disable("jarvis-core") is called
Then the response should contain error: "protected"
And jarvis-core should remain running
```

### Scenario: Dynamic piece registration from plugins

```gherkin
Given a plugin is installed with a piece "my-piece"
When the plugin is loaded by PluginManager
Then PieceManager.registerDynamic should start the piece
And piece_list should include "my-piece" as running
And the graph registry should include "my-piece" as a node with status "running"
And settings should have a default entry for "my-piece"
When the plugin is removed
Then the piece should be unregistered from graph and PieceManager
```

## Feature: HUD — Panel State Persistence

### Scenario: Panel layout is saved on drag/resize

```gherkin
Given a user drags the chat panel to position (100, 200) and resizes to (400, 300)
When the layout is saved via POST /hud/layout
Then settings.user.json should have chat-output.config.layout = { x: 100, y: 200, width: 400, height: 300 }
And on restart, the panel should appear at the saved position/size
```

### Scenario: Panel visibility is persisted

```gherkin
Given the token-counter panel is visible
When the user closes it via the HUD (POST /hud/hide)
Then settings.user.json should have token-counter.visible = false
And on restart, the panel should not be visible
When hud_show("token-counter") is called
Then settings.user.json should have token-counter.visible = true
And the panel should reappear
```

### Scenario: Detach/reattach persists to settings

```gherkin
Given the chat panel is attached (in the main HUD window)
When the user detaches it via POST /hud/detach
Then settings.user.json should have chat-output.config.detached = true
And the panel should open in a separate Electron window
When the user reattaches it via POST /hud/reattach
Then settings.user.json should have chat-output.config.detached = false
And the panel should return to the main HUD
```

### Scenario: Detached window layout persists

```gherkin
Given a panel is detached to a separate window
When the user moves/resizes the detached window
Then POST /hud/detach-layout should save position and size to settings.user.json
And on restart, GET /hud/detached should return the saved layout
```

### Scenario: Ephemeral panels do NOT persist

```gherkin
Given a plugin registers an ephemeral panel (ephemeral: true)
When the user moves or resizes the panel
Then settings.user.json should NOT contain an entry for that panel's layout
And when the panel is closed, no settings entry remains
```

### Scenario: hud_layout tool persists layout

```gherkin
Given the grpc panel exists
When hud_layout("grpc", 500, 100, 300, 200) is called
Then settings.user.json should have grpc.config.layout = { x: 500, y: 100, width: 300, height: 200 }
And the HUD should update the panel position in real-time
```

## Feature: Settings Integrity

### Scenario: Enable/disable reflects immediately in settings

```gherkin
Given cron is running (enabled: true in settings)
When piece_disable("cron") is called
Then reading settings.user.json should show cron.enabled = false
When piece_enable("cron") is called
Then reading settings.user.json should show cron.enabled = true
And no stale or orphan entries should exist in settings
```

### Scenario: Settings survive restart

```gherkin
Given various settings have been modified (layouts, visibility, detach state)
When JARVIS is restarted
Then all modified settings should be preserved
And pieces should start with saved enabled/disabled state
And panels should appear with saved position/size/visibility
```

### Scenario: Two-layer settings merge correctly

```gherkin
Given settings.json has default piece configurations
And settings.user.json has user overrides
When settings.load() is called
Then user values should override defaults
And settings.save() should write ONLY to settings.user.json
And settings.json should remain untouched
```

## Feature: HUD & SSE Streaming

### Scenario: SSE stream delivers state changes

```gherkin
Given a client is connected to GET /hud-stream
When a piece publishes a hud.update event
Then the client should receive an SSE delta with the updated component
And the delta should only be sent if the component data actually changed (dirty check)
```

### Scenario: SSE is quiet during idle

```gherkin
Given JARVIS is idle (no prompts being processed)
And a client is connected to GET /hud-stream
When 10 seconds pass with no user interaction
Then the number of SSE deltas received should be 0
And the hud-core-node 500ms timer and token-counter 1s timer should be suppressed by dirty check
```

### Scenario: Reactor status syncs with core node graph

```gherkin
Given the HUD is rendering the core node graph
When the session state changes from "online" to "processing"
Then the reactor delta should include the new status
And the graphRegistry should update jarvis-core status
And the core node label should display "PROCESSING"
And when idle, it should display "ONLINE"
```

### Scenario: GET /hud returns full snapshot

```gherkin
Given JARVIS is running with pieces active
When a client requests GET /hud
Then the response should include:
  - reactor: { status, coreLabel, coreSubLabel }
  - components: array of all registered HUD pieces
And each component should have: id, name, status, visible, position, size, data
```

### Scenario: Token counter displays streaming progress

```gherkin
Given the AI is streaming a response
Then the token counter panel should show:
  - A streaming verb (e.g. "Analyzing…")
  - Elapsed time counting up
  - Estimated output tokens
And when streaming completes, the display should switch to model name
```

## Feature: Chat Piece

### Scenario: Chat timeline shows only owned sessions

```gherkin
Given ChatPiece has timelineSessions = {"main"}
When an ai.stream event arrives for target "main"
Then it should appear in the chat timeline
When an ai.stream event arrives for target "some-plugin-session"
Then it should NOT appear in the chat timeline
```

### Scenario: Slash command interception

```gherkin
Given a slash command "/test" is registered via CapabilityRegistry
When the user sends "/test args" via POST /chat/send
Then the slash command handler should be invoked with args "args"
And the message should appear in chat as a user message
And the result should appear as a system message
And the prompt should NOT be sent to the AI session
```

### Scenario: Chat history hydration

```gherkin
Given the main session has processed messages
When GET /chat/history is requested
Then the response should contain ChatEntry[] with user and assistant messages
And tool_result messages should be filtered out
And tool_use blocks should appear as capability entries
```

## Feature: JarvisCore — Session Ownership

### Scenario: JarvisCore processes owned sessions only

```gherkin
Given JarvisCore owns sessions matching ["main", /^grpc-/]
When an ai.request arrives with target "main"
Then JarvisCore should process it
When an ai.request arrives with target "grpc-client1"
Then JarvisCore should process it
When an ai.request arrives with target "custom-session"
Then JarvisCore should NOT process it (no subscriber picks it up)
```

### Scenario: Plugins can register session patterns

```gherkin
Given a plugin calls jarvisCore.registerSessionPattern(/^plugin-/)
When an ai.request arrives with target "plugin-worker-1"
Then JarvisCore should process it
```

### Scenario: ReplyTo routing works generically

```gherkin
Given an ai.request arrives with target "main" and replyTo "some-session"
When the AI completes its response
Then JarvisCore should publish the response to target "some-session"
And the response should be prefixed with "[JARVIS]"
```

## Feature: Plugin System

### Scenario: Install a plugin from GitHub

```gherkin
Given a valid plugin exists at github.com/user/jarvis-plugin-test
When plugin_install is called with the repo URL
Then the plugin should be cloned to ~/.jarvis/plugins/
And npm install should run if package.json exists
And the plugin's pieces should be loaded, started, and registered in graph
And the plugin should appear in plugin_list as enabled
And settings should contain the plugin entry
```

### Scenario: Plugin renderer loads via esbuild

```gherkin
Given a plugin has a renderer at renderers/MyRenderer.tsx
When the HUD requests /plugins/<name>/renderers/MyRenderer.js
Then the server should compile the TSX via esbuild on-the-fly
And the output should include the React banner (window.__JARVIS_REACT destructure)
And the compiled JS should be cached by mtime (subsequent requests skip compilation)
```

### Scenario: Plugin context.md is injected into system prompt

```gherkin
Given a plugin has a context.md file
When the plugin is enabled
Then the content of context.md should appear in the system prompt
And it should be included in the plugin context block
```

### Scenario: Plugin renderer ErrorBoundary isolates crashes

```gherkin
Given a plugin renderer throws an error at render time
When the HUD renders that plugin panel
Then only the broken panel shows "⚠ Renderer crashed" with the error message
And the rest of the HUD continues working normally
```

### Scenario: Disable and re-enable a plugin

```gherkin
Given a plugin is installed and running
When plugin_disable is called
Then the plugin's pieces should be stopped and unregistered from graph
And its tools should be unregistered
And its context should be removed from the system prompt
When plugin_enable is called
Then the plugin should be reloaded and all pieces restarted
And its pieces should reappear in graph
```

### Scenario: Remove a plugin completely

```gherkin
Given a plugin is installed
When plugin_remove is called
Then the plugin directory should be deleted from ~/.jarvis/plugins/
And the plugin entry should be removed from settings
And all its pieces should be unregistered
```

## Feature: Cron Scheduling

### Scenario: Create a one-shot timer

```gherkin
Given JARVIS is online
When cron_create is called with cron "once:5s" and prompt "Say hello"
Then a job should appear in cron_list
And after ~5 seconds, the prompt "Say hello" should be sent to the target session
And the job should be removed from cron_list after execution
```

### Scenario: Create a recurring timer

```gherkin
Given JARVIS is online
When cron_create is called with cron "*/1 * * * *" and prompt "Status check"
Then the prompt should be sent every 1 minute
And the job should persist in cron_list
When cron_delete is called with the job ID
Then the recurring timer should stop
And the job should be removed from cron_list
```

### Scenario: Target session routing

```gherkin
Given JARVIS is online
When cron_create is called with target "main"
Then the prompt should be published with target "main"
When cron_create is called with target "custom-session"
Then the prompt should be published with target "custom-session"
And there should be no hardcoded session ID prefixes
```

## Feature: Context Compaction

### Scenario: Automatic compaction when context exceeds threshold

```gherkin
Given compaction is enabled with thresholdPercent 83.5
When the context window usage exceeds 83.5% of max tokens
Then compaction should be triggered automatically
And the ai.stream should emit a "compaction" event
And the token counter should show updated context usage (lower than before)
And the system.event should record the compaction with engine info
```

### Scenario: Force compaction via /compact slash command

```gherkin
Given JARVIS is running with conversation history in the main session
When the user types "/compact" in the chat input
Then the slash command should be intercepted (not sent to AI)
And the chat should show "✅ Context compacted successfully."
And the ai.stream should emit a "compaction" event with engine "fallback"
And the session messages should be replaced with a summary (2 messages: user summary + assistant ack)
And the session should be saved to disk after compaction
```

### Scenario: /compact when session is busy

```gherkin
Given JARVIS is processing a prompt in the main session
When the user types "/compact" in the chat input
Then the chat should show "⚠️ Session is busy — wait for it to finish before compacting."
And no compaction should be triggered
```

### Scenario: /compact appears in slash menu

```gherkin
Given the user types "/" in the chat input
When the slash menu opens
Then "/compact" should appear in the "system" category
And its description should be "Force context compaction — summarizes conversation to free tokens"
```

## Feature: Model Switching

### Scenario: Switch between providers

```gherkin
Given JARVIS is running on claude-sonnet-4-6
When model_set is called with model "gpt-4o"
Then the provider should switch to OpenAI
And model_get should return { model: "gpt-4o", provider: "openai" }
And the token counter should display the new model name
And subsequent prompts should use the new provider
```

## Feature: gRPC Server

### Scenario: gRPC lifecycle

```gherkin
Given grpc_status shows the server is running
When grpc_stop is called
Then the server should shut down gracefully
And grpc_status should show { running: false }
When grpc_start is called
Then the server should start on the configured port
And grpc_status should show { running: true }
```

### Scenario: gRPC target routing is generic

```gherkin
Given the gRPC server is running
When a client sends a message with target "some-session"
Then the sessionId should be "some-session" (used directly, no prefix)
When a client sends a message without a target but with clientId "c1"
Then the sessionId should be "grpc-c1"
```

## Feature: EventBus

### Scenario: Publish and subscribe

```gherkin
Given a subscriber is listening on channel "ai.stream"
When a message is published to "ai.stream" with target "main"
Then the subscriber should receive the message
And the message should include source, target, and event fields
```

### Scenario: Bus stats track events

```gherkin
Given the bus has processed events
When bus.stats is checked
Then it should report total subscription count and total event count
```

## Feature: Capabilities

### Scenario: File system capabilities are loaded

```gherkin
Given JARVIS starts with the capabilities/ directory containing JSON definitions
When CapabilityLoaderPiece loads
Then the following capabilities should be registered:
  bash, clear_session, edit_file, glob, grep, list_dir,
  multi_edit_file, read_file, jarvis_reset, hud_screenshot,
  web_fetch, web_search, write_file
And each should be callable and return results
```

### Scenario: jarvis_eval provides runtime introspection

```gherkin
Given JARVIS is running
When jarvis_eval is called with code "return bus.stats.events"
Then it should return the current event count (a number)
And it should have access to: bus, capabilityRegistry, sessions, providerRouter, config, pieces, jarvisCore, chatPiece
```

### Scenario: session_info returns session metadata

```gherkin
Given the main session exists
When session_info is called
Then it should return sessionId, label, state, messageCount, provider, model
And messageCount should be > 0 if messages have been exchanged
```

### Scenario: Diff viewer capabilities work

```gherkin
Given the diff-viewer piece is running
When hud_show_diff is called with before/after content
Then a diff tab should appear in the HUD
When hud_show_file is called with a file path
Then a file viewer tab should appear with syntax highlighting
When hud_compare_files is called with two file paths
Then a side-by-side comparison should appear
```

## Execution Checklist

Quick validation sequence — run in order:

```
1. piece_list()
   → Verify: all core pieces listed with correct enabled/running/protected status

2. jarvis_eval — check graph has all pieces:
   jarvis_eval('const gr = (await import("./core/graph-registry.js")).graphRegistry; return JSON.stringify(gr.getTree().map(n => n.id + ":" + n.status))')
   → Verify: jarvis-core + all pieces present with correct status

3. hud_screenshot()
   → Verify: HUD renders with core node graph showing all piece nodes

4. session_info()
   → Verify: main session exists with messageCount > 0

5. "What is 2+2?"
   → Verify: response contains "4", reactor cycles online→processing→online

6. jarvis_eval — reactor status check:
   jarvis_eval('const res = await fetch("http://localhost:50052/hud"); const d = await res.json(); return d.reactor.status')
   → Verify: returns "online"

7. jarvis_eval — SSE idle test:
   jarvis_eval('let count = 0; const res = await fetch("http://localhost:50052/hud-stream"); const reader = res.body.getReader(); const timer = setTimeout(() => reader.cancel(), 5000); try { while(true) { const {done} = await reader.read(); if(done) break; count++; } } catch {} return count')
   → Verify: ≤ 1 delta (only initial snapshot), 0 during idle

8. session_get_tools()
   → Verify: all expected tools registered (bash, read_file, edit_file, glob, grep, etc.)

9. cron_create(cron="once:3s", prompt="[SYSTEM] Cron test fired")
   → Verify: cron_list shows job, message arrives after ~3s, job removed

10. model_get()
    → Verify: returns current model and provider

11. piece_disable("cron") → read settings → piece_enable("cron") → read settings
    → Verify: settings reflect enabled: false then enabled: true

12. hud_layout("grpc", 100, 100, 300, 200) → read settings
    → Verify: settings contain grpc.config.layout with those values
```

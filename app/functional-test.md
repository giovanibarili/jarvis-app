# JARVIS Core — Functional Tests

> BDD scenarios for validating the JARVIS runtime end-to-end.
> Execute these after any code change, dependency update, or architecture refactor.

## Feature: Startup & Initialization

### Scenario: Clean boot with all pieces loaded

```gherkin
Given JARVIS is installed with default settings
When the process starts
Then piece_list should show all core pieces as running:
  | Piece              | Status  |
  | jarvis-core        | running |
  | capability-executor| running |
  | capability-loader  | running |
  | mcp-manager        | running |
  | chat               | running |
  | hud-core-node      | running |
  | cron               | running |
  | plugin-manager     | running |
And GET /hud should return a JSON with reactor.status "online"
And GET /hud should return components for all visible pieces
And the HUD Electron window should display the core node graph
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
And the chat should display the response "4"
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
And the core node label should display "PROCESSING" with orange color
And when idle, it should display "ONLINE" with green color
```

### Scenario: GET /hud returns full snapshot

```gherkin
Given JARVIS is running with pieces and plugins active
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
  - Elapsed time counting up (computed locally via requestAnimationFrame)
  - Estimated output tokens
And the elapsed timer should animate smoothly without backend SSE pushes
And when streaming completes, the display should switch to model name
```

## Feature: Settings Persistence

### Scenario: Panel layout is saved and restored

```gherkin
Given a user drags a panel to position (100, 200) and resizes to (400, 300)
When the layout is saved via the HUD
And JARVIS restarts
Then the panel should appear at position (100, 200) with size (400, 300)
And ephemeral panels should NOT have their layout persisted
```

### Scenario: Piece enable/disable persists

```gherkin
Given a non-protected piece is disabled via piece_disable
When JARVIS restarts
Then the piece should remain disabled
And protected pieces should always be enabled regardless of settings
```

## Feature: Plugin System

### Scenario: Install a plugin from GitHub

```gherkin
Given a valid plugin exists at github.com/user/jarvis-plugin-test
When I call plugin_install with the repo URL
Then the plugin should be cloned to ~/.jarvis/plugins/
And npm install should run if package.json exists
And the plugin's pieces should be loaded and started
And the plugin should appear in plugin_list as enabled
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
And it should be included in the plugin context block (after core context)
```

### Scenario: Disable and re-enable a plugin

```gherkin
Given a plugin is installed and running
When I call plugin_disable
Then the plugin's pieces should be stopped
And its tools should be unregistered
And its context should be removed from the system prompt
When I call plugin_enable
Then the plugin should be reloaded and all pieces restarted
```

## Feature: MCP (Model Context Protocol)

### Scenario: Connect to a configured MCP server

```gherkin
Given mcp.json has a server "test-server" configured
When I call mcp_connect with name "test-server"
Then the server should connect and register its tools as capabilities
And the tools should appear in session_get_tools with "mcp__test-server__" prefix
```

### Scenario: MCP server tools are callable

```gherkin
Given an MCP server is connected with tool "search"
When the AI calls mcp__server__search with valid parameters
Then the tool should execute via the MCP protocol
And the result should be returned to the AI session
```

## Feature: EventBus

### Scenario: Publish and subscribe

```gherkin
Given a subscriber is listening on channel "ai.stream"
When a message is published to "ai.stream" with target "main"
Then the subscriber should receive the message
And the message should include source, target, and event fields
```

### Scenario: Messages are only delivered to matching targets

```gherkin
Given subscriber A listens on "ai.stream" for target "main"
And subscriber B listens on "ai.stream" for target "actor-alice"
When a message is published to "ai.stream" with target "actor-alice"
Then only subscriber B should receive the message
```

## Feature: Cron Scheduling

### Scenario: Create a one-shot timer

```gherkin
Given JARVIS is online
When I call cron_create with cron "once:5s" and prompt "Say hello"
Then a job should be created in cron_list
And after ~5 seconds, the prompt "Say hello" should be sent to the main session
And the job should be removed from cron_list after execution
```

### Scenario: Create a recurring timer

```gherkin
Given JARVIS is online
When I call cron_create with cron "*/1 * * * *" and prompt "Status check"
Then the prompt should be sent every 1 minute
And the job should persist in cron_list
When I call cron_delete with the job ID
Then the recurring timer should stop
And the job should be removed from cron_list
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

## Feature: Model Switching

### Scenario: Switch between providers

```gherkin
Given JARVIS is running on claude-sonnet-4-6
When I call model_set with model "gpt-4o"
Then the provider should switch to OpenAI
And model_get should return "gpt-4o"
And the token counter should display the new model name
And subsequent prompts should use the new provider
```

## Feature: gRPC Server

### Scenario: gRPC lifecycle

```gherkin
Given grpc_status shows the server is stopped
When I call grpc_start
Then the gRPC server should start on port 50051
And grpc_status should show "running"
When I call grpc_stop
Then the server should shut down gracefully
And grpc_status should show "stopped"
```

## Execution Checklist

Quick validation sequence — run in order:

```
1. hud_screenshot()
   → Verify: HUD renders with core node graph, token counter, and all visible panels

2. session_info()
   → Verify: main session exists with message count > 0

3. "What is 2+2?"
   → Verify: response "4", reactor cycles online→processing→online

4. jarvis_eval('const res = await fetch("http://localhost:50052/hud"); const d = await res.json(); return d.reactor.status')
   → Verify: returns "online" (or "waiting_tools" if mid-eval)

5. jarvis_eval — SSE idle test (connect to /hud-stream, count deltas over 5s)
   → Verify: 0 deltas during idle (dirty check working)

6. piece_list()
   → Verify: all core pieces running

7. session_get_tools()
   → Verify: all expected tools registered (bash, read_file, edit_file, etc.)

8. cron_create(cron="once:3s", prompt="[SYSTEM] Cron test fired")
   → Verify: cron_list shows job, message arrives after ~3s, job removed

9. model_get()
   → Verify: returns current model
```

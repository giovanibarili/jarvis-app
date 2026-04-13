#!/bin/bash
# Patch @anthropic-ai/claude-agent-sdk to forward mcpServers to v2 sessions
# Tracks: https://github.com/anthropics/claude-agent-sdk-typescript/issues/176
# Remove this patch when the issue is resolved upstream.

SDK_DIR="node_modules/@anthropic-ai/claude-agent-sdk"

echo "Patching Claude Agent SDK (issue #176: mcpServers in v2 sessions)..."

# Patch runtime: forward mcpServers option to ProcessTransport
sed -i '' 's/mcpServers:{},strictMcpConfig/mcpServers:$.mcpServers??{},strictMcpConfig/' "$SDK_DIR/sdk.mjs"

# Patch types: add mcpServers to SDKSessionOptions
sed -i '' '/permissionMode?: PermissionMode;/{
n
/^};/{
i\
\    /** MCP servers (patched — issue #176) */\
\    mcpServers?: Record<string, McpServerConfig>;
}
}' "$SDK_DIR/sdk.d.ts"

echo "SDK patched successfully."

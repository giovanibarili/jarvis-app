# Multi-Provider AI Adapter — Design Spec

## Goal

Make JARVIS provider-agnostic. Support Anthropic (Claude), OpenAI-compatible (GPT-4o, Groq, Ollama), and future providers through a unified adapter layer. Each provider brings its own metrics HUD.

## Core Concept: Capabilities over Tools

The JARVIS `ToolRegistry` defines **capabilities** — actions the assistant can execute (bash, read_file, knowledge_search). Each capability has an abstract schema (name, description, input schema). Provider adapters translate capabilities to the model's native format:

- **Anthropic**: `tools` array with `input_schema`
- **OpenAI**: `tools` array with `function.parameters`
- **No function calling**: capabilities disabled, text-only mode

## Architecture

```
ToolRegistry (capabilities — provider-agnostic)
    │
    ▼
ProviderRouter
    ├── AnthropicProvider
    │     ├── AnthropicSessionFactory → AnthropicSession
    │     └── AnthropicMetricsHud (Piece)
    └── OpenAIProvider
          ├── OpenAISessionFactory → OpenAISession
          └── OpenAIMetricsHud (Piece)
```

`JarvisCore`, `ToolExecutor`, `ChatPiece`, `ChatOutput` — nothing changes. They work with `AISession` and `AIStreamEvent` interfaces, which remain the same.

## Provider Router

New file: `app/src/ai/provider.ts`

Manages the active provider. Exposes the current `AISessionFactory`. Handles switching:

```typescript
interface Provider {
  readonly name: string;
  readonly factory: AISessionFactory;
  start(bus: EventBus): Promise<void>;  // register HUD, subscribe to events
  stop(): Promise<void>;                // remove HUD, unsubscribe
}
```

The router holds the active `Provider`. On switch: stop old → start new.

## Anthropic Provider

Existing code reorganized into a provider:

- `app/src/ai/anthropic/session.ts` — unchanged
- `app/src/ai/anthropic/factory.ts` — unchanged
- `app/src/ai/anthropic/provider.ts` — new, wraps factory + metrics HUD
- `app/src/ai/anthropic/metrics-hud.ts` — extracted from current `output/token-counter.ts`

The AnthropicMetricsHud is a Piece that shows:
- Model name
- Input/output tokens (cumulative)
- cache_creation_input_tokens, cache_read_input_tokens
- Cache hit % (per-request)
- Context % (per-request)
- Request count

## OpenAI Provider

New implementation using the `openai` npm package:

- `app/src/ai/openai/session.ts` — `OpenAISession` implements `AISession`
- `app/src/ai/openai/factory.ts` — `OpenAISessionFactory` implements `AISessionFactory`
- `app/src/ai/openai/provider.ts` — wraps factory + metrics HUD
- `app/src/ai/openai/metrics-hud.ts` — OpenAI-specific metrics

The OpenAISession translates:
- System prompt: `TextBlockParam[]` → OpenAI `system` message string
- Capabilities: Anthropic tool format → OpenAI function calling format
- Streaming: OpenAI stream → `AIStreamEvent` yield
- Tool results: same loop pattern, different wire format

The OpenAIMetricsHud shows:
- Model name
- prompt_tokens, completion_tokens
- cached_tokens (if available)
- Estimated cost
- Request count

## Capability Translation

The `ToolRegistry.getDefinitions()` returns the current format:
```typescript
{ name: "bash", description: "...", input_schema: { type: "object", properties: {...} } }
```

Each provider translates to its native format:

**Anthropic** (no change): uses `input_schema` as-is

**OpenAI**: wraps in function calling format:
```typescript
{ type: "function", function: { name: "bash", description: "...", parameters: { type: "object", properties: {...} } } }
```

The JSON schemas are compatible — only the wrapper differs.

## Model Switching

The `model_set` tool is updated to understand providers:

- `model_set claude-sonnet-4-6` → Anthropic provider
- `model_set claude-opus-4-6` → Anthropic provider
- `model_set gpt-4o` → OpenAI provider (api.openai.com)
- `model_set llama3:70b` → OpenAI-compatible provider (localhost:11434)

Provider detection by model name prefix or a provider:model format.

When provider changes (Anthropic → OpenAI):
1. Old provider `stop()` — removes its metrics HUD
2. Session is reset (history cleared — formats are incompatible)
3. New provider `start()` — registers its metrics HUD
4. Next user message creates a fresh session with new provider

When only model changes within same provider (sonnet → opus):
- Session is reset (cache invalidated anyway)
- HUD stays, updates model name

## Config & Persistence

`settings.json` gains:
```json
{
  "model": "claude-sonnet-4-6",
  "providers": {
    "openai": {
      "apiKey": "env:OPENAI_API_KEY",
      "baseUrl": "https://api.openai.com/v1"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1"
    }
  }
}
```

API keys come from env vars (referenced by `env:VAR_NAME`). Base URLs allow pointing to any OpenAI-compatible endpoint.

## AIStreamEvent — No Change

```typescript
export interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  error?: string;
}
```

Each provider maps its native usage to these fields. OpenAI maps `prompt_tokens` → `input_tokens`, `completion_tokens` → `output_tokens`. Cache fields are 0 if not applicable.

## Files Impacted

**New files:**
- `app/src/ai/provider.ts` — ProviderRouter
- `app/src/ai/openai/session.ts` — OpenAISession
- `app/src/ai/openai/factory.ts` — OpenAISessionFactory
- `app/src/ai/openai/provider.ts` — OpenAI Provider wrapper
- `app/src/ai/openai/metrics-hud.ts` — OpenAI metrics HUD piece
- `app/src/ai/anthropic/provider.ts` — Anthropic Provider wrapper
- `app/src/ai/anthropic/metrics-hud.ts` — extracted from token-counter.ts

**Modified files:**
- `app/src/main.ts` — replace TokenCounter + factory with ProviderRouter
- `app/src/config/index.ts` — provider config, model-to-provider mapping
- `app/src/core/settings.ts` — providers section in Settings interface

**Removed files:**
- `app/src/output/token-counter.ts` — replaced by provider-specific metrics HUDs

## Dependencies

New npm package: `openai` (official OpenAI SDK for TypeScript)

## Out of Scope

- Prompt caching for OpenAI (different mechanism, future work)
- Vision/image support across providers
- Provider-specific system prompt optimization
- Cost tracking dashboard
- Streaming differences (OpenAI SSE format slightly different, handled in adapter)

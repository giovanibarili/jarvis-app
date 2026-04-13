# JARVIS Architecture Design

**Date:** 2026-04-13
**Status:** Approved
**Project:** JARVIS App (Agent SDK)

## Overview

JARVIS is an AI assistant app built on the Claude Agent SDK (TypeScript). It exposes a gRPC interface and uses a Lead + Actor model internally. Jarvis (the Lead) is the face of the system — he responds, analyzes, and orchestrates. Actors are workers that Jarvis spawns for delegated tasks.

## Architecture

Three layers with clear responsibilities:

**Jarvis (Lead)** is the system. He starts the application, exposes gRPC, responds on the terminal, consumes the message queue, and decides what to do with each message: process it himself (own SDKSession) or dispatch to an actor. He is what the user sees. Future: responds to hooks.

**Actors** are workers Jarvis spawns for delegated tasks. Each actor encapsulates its own SDKSession, identified by a `clientId`. Actors don't talk to the outside world — only to Jarvis. They are created on demand, reused across calls from the same client, and destroyed when idle.

**Transport** is the I/O layer. The gRPC server is the first transport — it serializes, deserializes, and enqueues. No logic. Future transports: WebSocket, HTTP, CLI.

```
Terminal -----+
              +----> Jarvis ----> processes directly (own session)
gRPC --> Queue --+            +-> dispatches to Actor (dedicated session)
                                  +-> result returns to Jarvis -> response
```

## Folder Structure

```
src/
  ai/
    types.ts             AISession interface + AIMessage types (SDK-agnostic contract)
    claude-agent/
      adapter.ts         Implements AISession using Claude Agent SDK v2
  jarvis/
    jarvis.ts            Lead: event loop, consumes queue, dispatches, responds
  actors/
    actor.ts             Actor base: encapsulates SDKSession, receives msg, returns result
    actor-pool.ts        Manages actor lifecycle (create, get, destroy)
  transport/
    grpc/
      server.ts          gRPC server, produces to queue
      client.ts          CLI client for testing
    proto/
      jarvis.proto       Service definition
  queue/
    message-queue.ts     Async queue with resolvers (enqueue returns Promise of result)
    types.ts             QueueMessage, QueueResponse
  tools/
    registry.ts          Custom tools registry (future)
  config/
    index.ts             Centralized config (model, tools, permissions, port, log level)
  logger/
    index.ts             Pino instance, exported as singleton
  main.ts                Entrypoint: composes everything, starts Jarvis
```

## Request Flow

1. gRPC server receives `SendMessage(prompt, client_id)`
2. Server creates a `QueueMessage` with prompt, clientId, and a pending Promise resolver
3. Server enqueues and awaits the Promise
4. Jarvis (event loop) dequeues the message
5. Jarvis decides: empty clientId -> own session; populated clientId -> dispatch to actor
6. If actor: Jarvis asks ActorPool for the actor matching that clientId (creates if absent)
7. Actor calls `session.send()` + `session.stream()`, collects result
8. Actor returns result to Jarvis
9. Jarvis resolves the original Promise
10. gRPC handler wakes up and returns the response

## Proto Definition

```protobuf
syntax = "proto3";
package jarvis;

service Jarvis {
  rpc SendMessage (MessageRequest) returns (MessageResponse);
}

message MessageRequest {
  string prompt = 1;
  string client_id = 2;
}

message MessageResponse {
  string result = 1;
  string session_id = 2;
}
```

Empty `client_id` means Jarvis handles it directly. Populated `client_id` dispatches to a dedicated actor.

## Components

**MessageQueue** — async FIFO queue. `enqueue()` returns a Promise that resolves when Jarvis processes that item. Each item carries: `id`, `prompt`, `clientId`, `timestamp`, and a `resolve/reject` pair for the caller's Promise.

**Jarvis** — starts with its own SDKSession. Runs a `while(true)` loop doing `await queue.dequeue()`. For each message: empty clientId -> own session; populated -> asks actor pool. Logs everything via pino. Future: hooks enter here as listeners on the event loop.

**Actor** — stateful. Created with a `clientId`, instantiates an SDKSession lazily (on first message). Exposes `process(prompt): Promise<string>`. Has `close()` for cleanup. Knows nothing about queues or transport.

**ActorPool** — `Map<clientId, Actor>`. `get(clientId)` returns existing actor or creates new. `destroy(clientId)` closes session and removes. Future: TTL for idle actors, max pool size.

**AISession interface** — SDK-agnostic contract that Jarvis and Actors depend on. Defines `send(prompt): Promise<void>`, `stream(): AsyncGenerator<AIMessage>`, `close(): void`, and `sessionId: string`. The Claude Agent SDK adapter (`ai/claude-agent/adapter.ts`) implements this interface using `unstable_v2_createSession`. To swap SDKs in the future, write a new adapter — nothing else changes.

**Config** — centralized object with model, allowed tools, permission mode, gRPC port, log level. Read once at startup.

**Logger** — pino instance with `pino-pretty` in dev. Exported as singleton, each module does `import { log } from '../logger'`.

## SDK Usage

No module outside `ai/claude-agent/` imports the Claude Agent SDK directly. All interaction goes through the `AISession` interface defined in `ai/types.ts`.

The current adapter uses the `unstable_v2` API for persistent sessions:

```typescript
// ai/types.ts — the contract
interface AISession {
  readonly sessionId: string;
  send(prompt: string): Promise<void>;
  stream(): AsyncGenerator<AIMessage, void>;
  close(): void;
}

// ai/claude-agent/adapter.ts — the implementation
const session = unstable_v2_createSession({ model, allowedTools, permissionMode });
// implements AISession by delegating to SDK's session.send/stream/close
```

This eliminates the ~5.5s spawn overhead per call that `query()` incurs. Measured latency: ~2s per call vs ~11s with `query()`.

To swap to a different AI SDK, implement a new adapter in `ai/<new-sdk>/adapter.ts` and change the factory in config. Jarvis, Actors, and all other modules remain untouched.

## Future Extensions

These are not in scope now but the architecture accommodates them:

- **Custom tools**: `tools/registry.ts` will use `tool()` + `createSdkMcpServer()` to register in-process tools
- **Voice/TTS**: Kokoro integration as a post-processing step on Jarvis responses
- **Streaming gRPC**: change proto to `stream MessageResponse` for token-level streaming via `includePartialMessages: true`
- **Hooks**: Jarvis listens for hook events and reacts (e.g., post-tool-use logging, permission decisions)
- **Actor TTL**: idle actors auto-close after configurable timeout
- **Max pool size**: limit concurrent actors to prevent resource exhaustion
- **Web UI**: new transport in `transport/ws/` or `transport/http/`

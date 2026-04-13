# JARVIS Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the JARVIS app from flat files into a Lead + Actor architecture with SDK abstraction, message queue, and gRPC transport.

**Architecture:** Jarvis (Lead) consumes a message queue, processes messages via its own AI session or dispatches to actors from a pool. The Claude Agent SDK is abstracted behind an `AISession` interface. gRPC is the transport layer producing to the queue.

**Tech Stack:** TypeScript, Claude Agent SDK v2 (`unstable_v2_createSession`), gRPC (`@grpc/grpc-js`), pino logger

---

## File Map

```
src/
  logger/index.ts          — NEW: pino singleton
  config/index.ts          — NEW: centralized config
  ai/types.ts              — NEW: AISession interface + AIMessage types
  ai/claude-agent/adapter.ts — NEW: Claude Agent SDK adapter
  queue/types.ts           — NEW: QueueMessage, QueueResponse types
  queue/message-queue.ts   — NEW: async FIFO queue with resolvers
  actors/actor.ts          — NEW: actor wrapping AISession
  actors/actor-pool.ts     — NEW: actor lifecycle manager
  jarvis/jarvis.ts         — NEW: Lead event loop
  transport/grpc/server.ts — NEW: gRPC server (producer)
  transport/grpc/client.ts — NEW: CLI client
  transport/proto/jarvis.proto — MOVE from proto/
  main.ts                  — NEW: entrypoint
  index.ts                 — DELETE (replaced by main.ts)
  server.ts                — DELETE (replaced by transport/grpc/server.ts + jarvis/jarvis.ts)
  client.ts                — DELETE (replaced by transport/grpc/client.ts)
```

---

### Task 1: Logger

**Files:**
- Create: `src/logger/index.ts`

- [ ] **Step 1: Create logger module**

```typescript
// src/logger/index.ts
import pino from "pino";

export const log = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
  level: process.env.LOG_LEVEL ?? "info",
});
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/dev/personal/jarvis-app && npx tsx -e "import { log } from './src/logger/index.ts'; log.info('hello');"`
Expected: prints a formatted log line with "hello"

- [ ] **Step 3: Commit**

```bash
git add src/logger/
git commit -m "feat: add pino logger module"
```

---

### Task 2: Config

**Files:**
- Create: `src/config/index.ts`

- [ ] **Step 1: Create config module**

```typescript
// src/config/index.ts
export interface JarvisConfig {
  model: string;
  allowedTools: string[];
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  grpcPort: number;
  logLevel: string;
}

export const config: JarvisConfig = {
  model: process.env.JARVIS_MODEL ?? "claude-sonnet-4-6",
  allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  permissionMode: "bypassPermissions",
  grpcPort: Number(process.env.JARVIS_GRPC_PORT ?? "50051"),
  logLevel: process.env.LOG_LEVEL ?? "info",
};
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/dev/personal/jarvis-app && npx tsx -e "import { config } from './src/config/index.ts'; console.log(config);"`
Expected: prints config object with defaults

- [ ] **Step 3: Commit**

```bash
git add src/config/
git commit -m "feat: add centralized config module"
```

---

### Task 3: AI Abstraction Layer

**Files:**
- Create: `src/ai/types.ts`
- Create: `src/ai/claude-agent/adapter.ts`

- [ ] **Step 1: Define AISession interface and AIMessage types**

```typescript
// src/ai/types.ts
export interface AIMessage {
  type: string;
  subtype?: string;
  result?: string;
  sessionId?: string;
  raw: unknown;
}

export interface AISession {
  readonly sessionId: string;
  send(prompt: string): Promise<void>;
  stream(): AsyncGenerator<AIMessage, void>;
  close(): void;
}

export interface AISessionFactory {
  create(): AISession;
}
```

- [ ] **Step 2: Implement Claude Agent SDK adapter**

```typescript
// src/ai/claude-agent/adapter.ts
import {
  unstable_v2_createSession,
  type SDKSession,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AISession, AIMessage, AISessionFactory } from "../types.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

function toAIMessage(msg: SDKMessage): AIMessage {
  const raw = msg as Record<string, unknown>;
  return {
    type: raw.type as string,
    subtype: raw.subtype as string | undefined,
    result: raw.type === "result" ? (raw.result as string | undefined) : undefined,
    sessionId: raw.session_id as string | undefined,
    raw: msg,
  };
}

class ClaudeAgentSession implements AISession {
  private session: SDKSession;
  private initialized = false;

  constructor() {
    log.debug("Creating Claude Agent SDK session");
    this.session = unstable_v2_createSession({
      model: config.model,
      allowedTools: config.allowedTools,
      permissionMode: config.permissionMode,
    });
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  async send(prompt: string): Promise<void> {
    this.initialized = true;
    await this.session.send(prompt);
  }

  async *stream(): AsyncGenerator<AIMessage, void> {
    for await (const msg of this.session.stream()) {
      yield toAIMessage(msg);
    }
  }

  close(): void {
    log.debug({ sessionId: this.initialized ? this.session.sessionId : "uninitialized" }, "Closing session");
    this.session.close();
  }
}

export class ClaudeAgentSessionFactory implements AISessionFactory {
  create(): AISession {
    return new ClaudeAgentSession();
  }
}
```

- [ ] **Step 3: Verify adapter compiles**

Run: `cd ~/dev/personal/jarvis-app && npx tsx -e "import { ClaudeAgentSessionFactory } from './src/ai/claude-agent/adapter.ts'; const f = new ClaudeAgentSessionFactory(); console.log('factory created:', typeof f.create);"`
Expected: prints "factory created: function"

- [ ] **Step 4: Commit**

```bash
git add src/ai/
git commit -m "feat: add AISession interface and Claude Agent SDK adapter"
```

---

### Task 4: Message Queue

**Files:**
- Create: `src/queue/types.ts`
- Create: `src/queue/message-queue.ts`

- [ ] **Step 1: Define queue types**

```typescript
// src/queue/types.ts
export interface QueueMessage {
  id: string;
  prompt: string;
  clientId: string;
  timestamp: number;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
}
```

- [ ] **Step 2: Implement async message queue**

```typescript
// src/queue/message-queue.ts
import { log } from "../logger/index.js";
import type { QueueMessage } from "./types.js";

export class MessageQueue {
  private queue: QueueMessage[] = [];
  private waiting: ((msg: QueueMessage) => void) | null = null;

  enqueue(prompt: string, clientId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const msg: QueueMessage = {
        id: crypto.randomUUID(),
        prompt,
        clientId,
        timestamp: Date.now(),
        resolve,
        reject,
      };

      log.debug({ id: msg.id, clientId }, "Enqueued message");

      if (this.waiting) {
        const waiter = this.waiting;
        this.waiting = null;
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  dequeue(): Promise<QueueMessage> {
    const next = this.queue.shift();
    if (next) {
      log.debug({ id: next.id }, "Dequeued message");
      return Promise.resolve(next);
    }

    return new Promise<QueueMessage>((resolve) => {
      this.waiting = (msg) => {
        log.debug({ id: msg.id }, "Dequeued message (was waiting)");
        resolve(msg);
      };
    });
  }

  get size(): number {
    return this.queue.length;
  }
}
```

- [ ] **Step 3: Test queue manually**

Run: `cd ~/dev/personal/jarvis-app && npx tsx -e "
import { MessageQueue } from './src/queue/message-queue.ts';
const q = new MessageQueue();
q.enqueue('hello', 'c1').then(r => console.log('result:', r));
q.dequeue().then(msg => { console.log('got:', msg.prompt); msg.resolve('world'); });
"`
Expected: prints "got: hello" then "result: world"

- [ ] **Step 4: Commit**

```bash
git add src/queue/
git commit -m "feat: add async message queue with promise resolvers"
```

---

### Task 5: Actor

**Files:**
- Create: `src/actors/actor.ts`
- Create: `src/actors/actor-pool.ts`

- [ ] **Step 1: Implement Actor**

```typescript
// src/actors/actor.ts
import type { AISession, AISessionFactory } from "../ai/types.js";
import { log } from "../logger/index.js";

export class Actor {
  readonly clientId: string;
  private session: AISession | null = null;
  private factory: AISessionFactory;

  constructor(clientId: string, factory: AISessionFactory) {
    this.clientId = clientId;
    this.factory = factory;
    log.info({ clientId }, "Actor created");
  }

  async process(prompt: string): Promise<string> {
    if (!this.session) {
      this.session = this.factory.create();
      log.debug({ clientId: this.clientId }, "Actor session initialized (lazy)");
    }

    const t0 = Date.now();
    await this.session.send(prompt);

    let result = "";
    for await (const msg of this.session.stream()) {
      if (msg.type === "result" && msg.result) {
        result = msg.result;
      }
    }

    log.info({ clientId: this.clientId, ms: Date.now() - t0, resultLength: result.length }, "Actor processed");
    return result;
  }

  close(): void {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    log.info({ clientId: this.clientId }, "Actor closed");
  }
}
```

- [ ] **Step 2: Implement ActorPool**

```typescript
// src/actors/actor-pool.ts
import { Actor } from "./actor.js";
import type { AISessionFactory } from "../ai/types.js";
import { log } from "../logger/index.js";

export class ActorPool {
  private actors = new Map<string, Actor>();
  private factory: AISessionFactory;

  constructor(factory: AISessionFactory) {
    this.factory = factory;
  }

  get(clientId: string): Actor {
    let actor = this.actors.get(clientId);
    if (!actor) {
      actor = new Actor(clientId, this.factory);
      this.actors.set(clientId, actor);
      log.debug({ clientId, poolSize: this.actors.size }, "Actor added to pool");
    }
    return actor;
  }

  destroy(clientId: string): void {
    const actor = this.actors.get(clientId);
    if (actor) {
      actor.close();
      this.actors.delete(clientId);
      log.debug({ clientId, poolSize: this.actors.size }, "Actor removed from pool");
    }
  }

  destroyAll(): void {
    for (const [clientId] of this.actors) {
      this.destroy(clientId);
    }
  }

  get size(): number {
    return this.actors.size;
  }
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app && npx tsx -e "import { ActorPool } from './src/actors/actor-pool.ts'; console.log('ActorPool loaded');"`
Expected: prints "ActorPool loaded"

- [ ] **Step 4: Commit**

```bash
git add src/actors/
git commit -m "feat: add Actor and ActorPool with lazy session init"
```

---

### Task 6: Jarvis Lead

**Files:**
- Create: `src/jarvis/jarvis.ts`

- [ ] **Step 1: Implement Jarvis**

```typescript
// src/jarvis/jarvis.ts
import type { AISession, AISessionFactory } from "../ai/types.js";
import { ActorPool } from "../actors/actor-pool.js";
import { MessageQueue } from "../queue/message-queue.js";
import { log } from "../logger/index.js";

export class Jarvis {
  private session: AISession;
  private actorPool: ActorPool;
  private queue: MessageQueue;
  private running = false;

  constructor(factory: AISessionFactory, queue: MessageQueue) {
    this.session = factory.create();
    this.actorPool = new ActorPool(factory);
    this.queue = queue;
    log.info("Jarvis initialized");
  }

  async start(): Promise<void> {
    this.running = true;
    log.info("Jarvis event loop started");

    while (this.running) {
      const msg = await this.queue.dequeue();
      log.info({ id: msg.id, clientId: msg.clientId, prompt: msg.prompt }, "Processing message");

      try {
        const result = msg.clientId
          ? await this.dispatchToActor(msg.prompt, msg.clientId)
          : await this.processDirectly(msg.prompt);

        msg.resolve(result);
      } catch (err) {
        log.error({ err, id: msg.id }, "Failed to process message");
        msg.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async processDirectly(prompt: string): Promise<string> {
    const t0 = Date.now();
    await this.session.send(prompt);

    let result = "";
    for await (const msg of this.session.stream()) {
      if (msg.type === "result" && msg.result) {
        result = msg.result;
      }
    }

    log.info({ ms: Date.now() - t0, resultLength: result.length }, "Jarvis processed directly");
    return result;
  }

  private async dispatchToActor(prompt: string, clientId: string): Promise<string> {
    const actor = this.actorPool.get(clientId);
    return actor.process(prompt);
  }

  stop(): void {
    this.running = false;
    this.session.close();
    this.actorPool.destroyAll();
    log.info("Jarvis stopped");
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd ~/dev/personal/jarvis-app && npx tsx -e "import { Jarvis } from './src/jarvis/jarvis.ts'; console.log('Jarvis loaded');"`
Expected: prints "Jarvis loaded"

- [ ] **Step 3: Commit**

```bash
git add src/jarvis/
git commit -m "feat: add Jarvis Lead with event loop and actor dispatch"
```

---

### Task 7: gRPC Transport

**Files:**
- Move: `proto/jarvis.proto` -> `src/transport/proto/jarvis.proto`
- Create: `src/transport/grpc/server.ts`
- Create: `src/transport/grpc/client.ts`

- [ ] **Step 1: Move and update proto**

```bash
mkdir -p ~/dev/personal/jarvis-app/src/transport/proto
```

```protobuf
// src/transport/proto/jarvis.proto
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

- [ ] **Step 2: Implement gRPC server**

```typescript
// src/transport/grpc/server.ts
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MessageQueue } from "../../queue/message-queue.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "..", "proto", "jarvis.proto");

export class GrpcServer {
  private server: grpc.Server;
  private queue: MessageQueue;

  constructor(queue: MessageQueue) {
    this.queue = queue;

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition).jarvis as any;
    this.server = new grpc.Server();
    this.server.addService(proto.Jarvis.service, {
      SendMessage: this.handleSendMessage.bind(this),
    });
  }

  private async handleSendMessage(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const { prompt, client_id } = call.request;
    log.debug({ prompt, clientId: client_id }, "gRPC SendMessage received");

    try {
      const result = await this.queue.enqueue(prompt, client_id ?? "");
      callback(null, { result, session_id: "" });
    } catch (err) {
      log.error({ err }, "gRPC SendMessage failed");
      callback({ code: grpc.status.INTERNAL, message: String(err) });
    }
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(
        `0.0.0.0:${config.grpcPort}`,
        grpc.ServerCredentials.createInsecure(),
        (err, port) => {
          if (err) {
            reject(err);
            return;
          }
          log.info({ port }, "gRPC server listening");
          resolve(port);
        }
      );
    });
  }

  stop(): void {
    this.server.forceShutdown();
    log.info("gRPC server stopped");
  }
}
```

- [ ] **Step 3: Implement gRPC client**

```typescript
// src/transport/grpc/client.ts
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "..", "proto", "jarvis.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition).jarvis as any;

const host = process.argv[2] ?? "localhost:50051";
const prompt = process.argv[3];
const clientId = process.argv[4] ?? "";

if (!prompt) {
  console.error("Usage: tsx src/transport/grpc/client.ts [host:port] \"prompt\" [clientId]");
  process.exit(1);
}

const client = new proto.Jarvis(host, grpc.credentials.createInsecure());

client.SendMessage({ prompt, client_id: clientId }, (err: any, response: any) => {
  if (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
  console.log(response.result);
});
```

- [ ] **Step 4: Commit**

```bash
git add src/transport/
git commit -m "feat: add gRPC server and client transport"
```

---

### Task 8: Entrypoint and Cleanup

**Files:**
- Create: `src/main.ts`
- Delete: `src/index.ts`
- Delete: `src/server.ts`
- Delete: `src/client.ts`
- Delete: `proto/` (moved to src/transport/proto/)
- Modify: `package.json` — update scripts

- [ ] **Step 1: Create main entrypoint**

```typescript
// src/main.ts
import { ClaudeAgentSessionFactory } from "./ai/claude-agent/adapter.js";
import { MessageQueue } from "./queue/message-queue.js";
import { Jarvis } from "./jarvis/jarvis.js";
import { GrpcServer } from "./transport/grpc/server.js";
import { log } from "./logger/index.js";

async function main() {
  const factory = new ClaudeAgentSessionFactory();
  const queue = new MessageQueue();
  const jarvis = new Jarvis(factory, queue);
  const grpcServer = new GrpcServer(queue);

  await grpcServer.start();

  process.on("SIGINT", () => {
    log.info("Shutting down...");
    jarvis.stop();
    grpcServer.stop();
    process.exit(0);
  });

  await jarvis.start();
}

main().catch((err) => {
  log.fatal({ err }, "Startup failed");
  process.exit(1);
});
```

- [ ] **Step 2: Delete old files**

```bash
rm src/index.ts src/server.ts src/client.ts
rm -rf proto/
```

- [ ] **Step 3: Update package.json scripts**

Update scripts in `package.json`:
```json
{
  "scripts": {
    "start": "tsx src/main.ts",
    "client": "tsx src/transport/grpc/client.ts",
    "dev": "tsx watch src/main.ts"
  }
}
```

- [ ] **Step 4: Verify full system starts**

Run: `cd ~/dev/personal/jarvis-app && npx tsx src/main.ts`
Expected: Jarvis initializes, gRPC server binds on port 50051, event loop starts

- [ ] **Step 5: Test via gRPC client**

Run (in another terminal): `cd ~/dev/personal/jarvis-app && npx tsx src/transport/grpc/client.ts localhost:50051 "Diga apenas: ping"`
Expected: prints "pong" or similar short response

- [ ] **Step 6: Test session continuity**

Run: `cd ~/dev/personal/jarvis-app && npx tsx src/transport/grpc/client.ts localhost:50051 "O que eu disse antes?"`
Expected: references "ping" from the previous message (same session via Jarvis Lead)

- [ ] **Step 7: Test actor dispatch with clientId**

Run: `cd ~/dev/personal/jarvis-app && npx tsx src/transport/grpc/client.ts localhost:50051 "Diga apenas: hello" client-1`
Expected: prints response, actor created for client-1

- [ ] **Step 8: Commit everything**

```bash
git add -A
git commit -m "feat: restructure into Lead + Actor architecture

- AISession abstraction layer (SDK-agnostic)
- Claude Agent SDK adapter using v2 persistent sessions
- Jarvis Lead with event loop and actor dispatch
- ActorPool with lazy session init
- Async message queue with promise resolvers
- gRPC transport (server + client)
- Centralized config and pino logger
- Removed old flat files (index.ts, server.ts, client.ts)"
```

---

## Self-Review Notes

- All spec sections are covered: AI abstraction (Task 3), Queue (Task 4), Actors (Task 5), Jarvis Lead (Task 6), Transport (Task 7), Config/Logger (Tasks 1-2), Entrypoint (Task 8)
- No placeholders — every step has complete code
- Type names are consistent across tasks: `AISession`, `AIMessage`, `AISessionFactory`, `QueueMessage`, `Actor`, `ActorPool`, `Jarvis`, `GrpcServer`, `MessageQueue`
- Import paths use `.js` extension as required by ESM with `type: "module"`
- Proto moved from `proto/` to `src/transport/proto/`
- Client accepts optional host parameter and clientId for actor testing

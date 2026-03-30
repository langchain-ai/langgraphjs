# Agent Streaming Protocol — Implementation Plan

> **Status**: Draft  
> **Companion**: [Protocol Design](./agent_streaming_protocol_design.md) |
> [CDDL Schema](./agent_streaming_protocol.cddl)  
> **Date**: 2026-03-26

## 1. Versioning Strategy

The protocol is exposed as a **v2 opt-in** API surface. Existing `graph.stream()`
and all current SDK/server behavior remain untouched (v1). Users opt into v2
explicitly:

```typescript
// In-process: opt in via createSession
import { createSession } from "@langchain/langgraph/protocol";

// Frontend hooks: opt in via protocol transport
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";

const stream = useStream({
  transport: new ProtocolStreamTransport({ url: "ws://localhost:2024/v2/runs" }),
  // ... existing useStream options work unchanged
});

// Server: opt in via v2 endpoint prefix
// GET  /v2/runs/:runId/ws     → WebSocket upgrade
// GET  /v2/runs/:runId/stream → SSE with subscription commands via POST
// POST /runs/stream           → unchanged v1 behavior
```

The v2 surface lives in new files and new subpath exports. No existing file
signatures change. No existing tests break.

---

## 2. Package Architecture

```
libs/
├── langgraph-core/          (@langchain/langgraph)
│   └── src/
│       └── pregel/
│           └── protocol/    ← NEW directory: protocol internals
│
├── langgraph-api/           (@langchain/langgraph-api)
│   └── src/
│       └── api/
│           └── v2/          ← NEW directory: v2 HTTP + WebSocket routes
│
├── sdk/                     (@langchain/langgraph-sdk)
│   └── src/
│       └── protocol/        ← NEW directory: protocol client + transport
│
├── sdk-react/               (@langchain/react)
│   └── src/
│       └── protocol.tsx     ← NEW: ProtocolStreamTransport for React
│
├── sdk-vue/                 (@langchain/vue)
│   └── src/
│       └── protocol.ts      ← NEW: ProtocolStreamTransport for Vue
│
├── sdk-svelte/              (@langchain/svelte)
│   └── src/
│       └── protocol.ts      ← NEW: ProtocolStreamTransport for Svelte
│
├── sdk-angular/             (@langchain/angular)
│   └── src/
│       └── protocol.ts      ← NEW: ProtocolStreamTransport for Angular
│
└── langgraph/               (langgraph — re-export wrapper)
    └── src/
        └── protocol.ts      ← NEW: re-export from core
```

### New subpath exports

| Package | Subpath | Content |
|---------|---------|---------|
| `@langchain/langgraph` | `./protocol` | `createSession`, `Session`, subscription types, protocol types |
| `@langchain/langgraph-sdk` | `./protocol` | `ProtocolClient` (WebSocket/SSE), shared protocol transport logic |
| `@langchain/react` | `./protocol` | `ProtocolStreamTransport` — `UseStreamTransport` impl for React's `useStream` |
| `@langchain/vue` | `./protocol` | `ProtocolStreamTransport` — for Vue's `useStream` composable |
| `@langchain/svelte` | `./protocol` | `ProtocolStreamTransport` — for Svelte's `useStream` store |
| `@langchain/angular` | `./protocol` | `ProtocolStreamTransport` — for Angular's stream service |
| `@langchain/langgraph-api` | `./v2` | v2 route handlers (WebSocket + SSE) |
| `langgraph` | `./protocol` | Re-export from `@langchain/langgraph/protocol` |

### Frontend Integration via `UseStreamTransport`

The framework SDKs (React, Vue, Svelte, Angular) already support custom
transports via the `UseStreamTransport` interface. Each `useStream` hook
selects between `useStreamLGP` (default LangGraph Platform transport) and
`useStreamCustom` (custom transport) based on whether a `transport` option
is provided.

The v2 protocol integrates through this existing pattern. Each framework
SDK gets a `ProtocolStreamTransport` that implements `UseStreamTransport`
using the protocol's WebSocket connection:

```typescript
// In any framework (React example shown)
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";

const stream = useStream({
  transport: new ProtocolStreamTransport({
    url: "ws://localhost:2024/v2/runs",
  }),
  // All existing useStream options work unchanged:
  // threadId, onThreadId, messagesKey, onError, onFinish, etc.
});

// Additional protocol features available on the transport:
stream.transport.subscribe("lifecycle");
stream.transport.resource.list(["agent_1"], "/workspace/src");
```

The `ProtocolStreamTransport` internally manages the WebSocket connection,
translates protocol events into the SSE-shaped `{ event, data }` format
that `useStream`'s orchestrator expects, and exposes additional protocol
features (subscriptions, commands) as extra methods on the transport
instance. This means existing `useStream` rendering logic (messages,
interrupts, tool calls, subagent streams) works unchanged — the protocol
transport is a drop-in replacement for the default SSE transport.

---

## 3. New Files in `langgraph-core`

All new protocol code lives under `libs/langgraph-core/src/pregel/protocol/`.
This keeps the protocol implementation isolated from the existing stream
pipeline and allows independent iteration.

```
libs/langgraph-core/src/pregel/protocol/
├── index.ts                 Entry point — exports createSession, types
├── types.ts                 Protocol-specific types (ProtocolEvent, ProtocolCommand, etc.)
├── session.ts               Session class — wraps a graph run with subscriptions + commands
├── registry.ts              SubscriptionRegistry — namespace + channel filtering
├── buffer.ts                EventBuffer — bounded ring buffer with replay
├── dispatcher.ts            EventDispatcher — routes chunks to matching subscriptions
├── channels/
│   ├── lifecycle.ts         Lifecycle event emission (spawned/completed/failed)
│   ├── resource.ts          Resource command handlers (list/read/write/download)
│   ├── sandbox.ts           Sandbox command handlers (input/kill) + event emission
│   ├── input.ts             Input command handlers (respond/inject) + event emission
│   ├── state.ts             State command handlers (get/storeSearch/storePut/fork)
│   └── usage.ts             Usage event emission (llmCall/summary) + budget enforcement
└── transport/
    ├── types.ts             Transport-agnostic interfaces
    ├── in-process.ts        In-process transport (typed iterators, zero serialization)
    └── websocket.ts         WebSocket transport (JSON text frames + binary media frames)
```

### 3.1 `protocol/types.ts`

Protocol-level types are **generated** from the CDDL schema using
[`cddl2ts`](https://github.com/webdriverio/cddl/tree/main/packages/cddl2ts),
the same tool the WebDriver BiDi project uses to generate TypeScript types
from their CDDL spec. The generation is a build-time step:

```bash
npx cddl2ts ./docs/docs/concepts/agent_streaming_protocol.cddl > \
  ./libs/langgraph-core/src/pregel/protocol/types.generated.ts
```

The generated types are checked into the repository (not generated on every
build) so that consumers don't need the `cddl2ts` toolchain. When the CDDL
schema changes, a maintainer re-runs the generation and commits the result.
Python and Java types are generated from the same `.cddl` file using
equivalent tools for those languages.

The generated output looks like:

```typescript
export interface ProtocolEvent<T = unknown> {
  type: "event";
  method: string;
  params: {
    namespace: string[];
    timestamp: number;
    data: T;
  };
}

export interface ProtocolCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface ProtocolResponse<T = unknown> {
  type: "success";
  id: number;
  result: T;
}

export interface ProtocolError {
  type: "error";
  id: number;
  error: string;
  message: string;
}

export type Channel =
  | "values" | "updates" | "messages" | "tools" | "custom"
  | "lifecycle" | "media" | "resource" | "sandbox" | "input"
  | "state" | "usage" | "debug" | "checkpoints" | "tasks";

export interface SubscribeOptions {
  channels: Channel[];
  namespaces?: string[][];
  depth?: number;
  mediaTypes?: ("audio" | "video" | "image")[];
}

export interface Subscription {
  id: string;
  options: SubscribeOptions;
}
```

### 3.2 `protocol/registry.ts` — SubscriptionRegistry

The core filtering engine. Maintains a list of active subscriptions and
tests each incoming chunk against them.

```typescript
import type { StreamChunk } from "../stream.js";
import type { Subscription, SubscribeOptions, Channel } from "./types.js";

export class SubscriptionRegistry {
  private subscriptions: Map<string, Subscription> = new Map();

  subscribe(options: SubscribeOptions): Subscription { /* ... */ }
  unsubscribe(id: string): void { /* ... */ }

  /**
   * Test whether a chunk matches any active subscription.
   * Returns the set of subscription IDs that match.
   */
  match(chunk: StreamChunk): Set<string> {
    const [namespace, mode] = chunk;
    const matches = new Set<string>();
    for (const [id, sub] of this.subscriptions) {
      if (!sub.options.channels.includes(mode as Channel)) continue;
      if (sub.options.namespaces && !this.prefixMatch(namespace, sub.options)) continue;
      matches.add(id);
    }
    return matches;
  }

  private prefixMatch(namespace: string[], options: SubscribeOptions): boolean {
    /* namespace prefix matching with depth limit */
  }
}
```

**Integration point**: The registry does NOT modify `IterableReadableWritableStream`
or `createDuplexStream`. Instead, it sits in the `Session` layer between the
stream consumer and the user's subscription iterators. The existing stream
pipeline produces all chunks as it does today; the registry filters at the
consumption boundary.

This is the key architectural decision: **the existing stream pipeline is
unchanged**. Filtering happens outside it, not inside it. This avoids the
hard problem of subscription-aware duplex streaming (identified in the design
doc section 10.5) and keeps all existing tests passing.

```
  Existing pipeline (unchanged)
  ─────────────────────────────────────────────
  PregelLoop._emit() → stream.push() → for await (chunk of stream)
  ─────────────────────────────────────────────
                                         │
                              ┌──────────┴──────────┐
                              │                     │
                      v1 path (unchanged)    v2 path (new)
                              │                     │
                        yield chunk         SubscriptionRegistry
                        (current shape)      .match(chunk)
                                                    │
                                            ┌───────┴───────┐
                                            │               │
                                     Sub A queue     Sub B queue
                                     (messages,      (tools,
                                      agent_1)        agent_2)
```

### 3.3 `protocol/buffer.ts` — EventBuffer

Bounded ring buffer storing recent events for replay on new subscriptions
and reconnection.

```typescript
export class EventBuffer {
  private buffer: ProtocolEvent[];
  private capacity: number;
  private cursor: number = 0;

  constructor(capacity: number = 1000) { /* ... */ }

  append(event: ProtocolEvent): void { /* ring buffer append */ }

  /**
   * Replay events matching a subscription. Returns events in order.
   * Caller must drain any new events after replay (snapshot-drain pattern).
   */
  replay(options: SubscribeOptions): ProtocolEvent[] { /* ... */ }
}
```

### 3.4 `protocol/dispatcher.ts` — EventDispatcher

Bridges the existing `StreamChunk` tuples to the protocol's `ProtocolEvent`
format and dispatches to per-subscription async queues.

```typescript
import type { StreamChunk } from "../stream.js";
import { SubscriptionRegistry } from "./registry.js";
import { EventBuffer } from "./buffer.js";
import type { ProtocolEvent, Channel } from "./types.js";

export class EventDispatcher {
  private registry: SubscriptionRegistry;
  private buffer: EventBuffer;
  private queues: Map<string, AsyncQueue<ProtocolEvent>> = new Map();

  /**
   * Called for every chunk from the stream. Wraps it as a ProtocolEvent,
   * appends to buffer, and dispatches to matching subscription queues.
   */
  dispatch(chunk: StreamChunk): void {
    const [namespace, mode, payload] = chunk;
    const event: ProtocolEvent = {
      type: "event",
      method: mode,
      params: { namespace, timestamp: Date.now(), data: payload },
    };
    this.buffer.append(event);
    for (const subId of this.registry.match(chunk)) {
      this.queues.get(subId)?.push(event);
    }
  }
}
```

### 3.5 `protocol/session.ts` — Session

The public API for in-process protocol access. Wraps a graph run.

```typescript
import type { Pregel } from "../index.js";
import type { PregelOptions } from "../types.js";
import { EventDispatcher } from "./dispatcher.js";
import type { SubscribeOptions, ProtocolEvent, Channel } from "./types.js";

export class Session {
  private graph: Pregel;
  private dispatcher: EventDispatcher;
  private runPromise: Promise<void>;

  constructor(graph: Pregel, options: SessionOptions) {
    this.dispatcher = new EventDispatcher();

    // Start the graph run in the background, piping all chunks
    // through the dispatcher
    this.runPromise = this.startRun(graph, options);
  }

  /**
   * Subscribe to events. Returns a typed async iterable that yields
   * only matching events. Multiple subscriptions can be active
   * concurrently.
   */
  subscribe(
    channels: Channel | Channel[],
    options?: { namespaces?: string[][]; depth?: number }
  ): AsyncIterable<ProtocolEvent> {
    /* creates subscription in registry, returns async iterator over queue */
  }

  unsubscribe(subscriptionId: string): void { /* ... */ }

  // Command namespaces — each delegates to the appropriate channel handler
  readonly resource = { /* list, read, write, download */ };
  readonly sandbox = { /* input, kill */ };
  readonly input = { /* respond, inject */ };
  readonly state = { /* get, storeSearch, storePut, listCheckpoints, fork */ };
  readonly usage = { /* setBudget */ };
  readonly agent = { /* getTree */ };

  private async startRun(graph: Pregel, options: SessionOptions): Promise<void> {
    // Calls graph._streamIterator() with all modes enabled,
    // subgraphs: true, and pipes every chunk through dispatcher.dispatch()
    const allModes = ["values","updates","messages","tools","custom",
                      "debug","checkpoints","tasks"];
    for await (const chunk of graph._streamIterator(options.input, {
      ...options.config,
      streamMode: allModes,
      subgraphs: true,
    })) {
      this.dispatcher.dispatch(chunk as StreamChunk);
    }
  }
}

export function createSession(
  graph: Pregel,
  options: SessionOptions
): Session {
  return new Session(graph, options);
}
```

**Key design**: `startRun` subscribes to ALL modes with `subgraphs: true`.
This means the existing stream pipeline produces everything, and filtering
happens in the dispatcher. The performance cost of producing unused events
is acceptable because:

1. The stream pipeline doesn't serialize — chunks are JS objects in memory
2. The dispatcher's `match()` is a simple set lookup + prefix comparison
3. Unmatched events are discarded immediately (no queue allocation)

For production high-fan-out scenarios where even producing all events is
costly, a future optimization can add a `SubscriptionRegistry` reference
to `_emit()` in `PregelLoop` for early filtering. But this is an
optimization, not a requirement for v2.

---

## 4. New Files in `langgraph-api`

The API server gets v2 endpoints for WebSocket and SSE with subscriptions.

```
libs/langgraph-api/src/api/v2/
├── index.mts                v2 Hono router
├── protocol.mts             Protocol server — manages sessions per connection
├── websocket.mts            WebSocket upgrade handler
└── sse.mts                  SSE + HTTP POST subscription management
```

### 4.1 `v2/index.mts` — Router

```typescript
import { Hono } from "hono";
import { websocketHandler } from "./websocket.mjs";
import { sseHandler, subscriptionHandler } from "./sse.mjs";

const v2 = new Hono();

// WebSocket: single bidirectional connection
v2.get("/v2/runs/:runId/ws", websocketHandler);

// SSE: server→client events + HTTP POST for commands
v2.get("/v2/runs/:runId/stream", sseHandler);
v2.post("/v2/runs/:runId/command", subscriptionHandler);

export default v2;
```

### 4.2 `v2/websocket.mts` — WebSocket Transport

```typescript
import { upgradeWebSocket } from "hono/websocket";
import { ProtocolServer } from "./protocol.mjs";

export const websocketHandler = upgradeWebSocket((c) => {
  const server = new ProtocolServer(/* graph, config from context */);

  return {
    onMessage(event, ws) {
      // Parse JSON command, dispatch to server, send response
      const command = JSON.parse(event.data);
      const response = server.handleCommand(command);
      ws.send(JSON.stringify(response));
    },

    onOpen(event, ws) {
      // Start forwarding events from server to client
      server.onEvent((protocolEvent) => {
        ws.send(JSON.stringify(protocolEvent));
      });

      // For binary media frames
      server.onBinaryFrame((header, payload) => {
        const frame = new Uint8Array(16 + payload.byteLength);
        // Write 16-byte header + payload
        ws.send(frame);
      });
    },

    onClose() {
      server.close();
    },
  };
});
```

### 4.3 Server integration

The v2 router is mounted alongside v1 in `server.mts`:

```typescript
// In libs/langgraph-api/src/server.mts
import v2 from "./api/v2/index.mjs";

// Existing v1 routes (unchanged)
app.route("/", runs);
app.route("/", threads);
// ...

// v2 routes (new, opt-in)
app.route("/", v2);
```

---

## 5. New Files in `sdk` and Framework SDKs

### 5.1 Protocol Client (`libs/sdk/src/protocol/`)

The shared protocol client lives in `@langchain/langgraph-sdk` and handles
WebSocket connection management, command dispatch, and binary frame
parsing. It is framework-agnostic.

```
libs/sdk/src/protocol/
├── index.ts                 Entry point — exports ProtocolClient, types
├── client.ts                ProtocolClient — WebSocket connection, command/event dispatch
├── subscription.ts          Typed subscription async iterators
└── types.ts                 Re-exports from @langchain/langgraph/protocol types
```

```typescript
// libs/sdk/src/protocol/client.ts

export class ProtocolClient {
  private ws: WebSocket;
  private commandId: number = 0;
  private pending: Map<number, { resolve, reject }> = new Map();

  constructor(options: { url: string }) {
    this.ws = new WebSocket(options.url);
    this.ws.onmessage = (event) => this.handleMessage(event);
  }

  async subscribe(channels: Channel[], options?: SubscribeOptions) { /* ... */ }

  readonly resource = { /* list, read, write, download */ };
  readonly sandbox = { /* input, kill */ };
  readonly input = { /* respond, inject */ };
  readonly state = { /* get, storeSearch, storePut, listCheckpoints, fork */ };
  readonly usage = { /* setBudget */ };
  readonly agent = { /* getTree */ };

  private async sendCommand(method: string, params: any): Promise<any> {
    const id = this.commandId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      this.handleBinaryFrame(event.data);
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.type === "success" || msg.type === "error") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        msg.type === "success" ? pending.resolve(msg.result) : pending.reject(msg);
      }
    } else if (msg.type === "event") {
      this.dispatchEvent(msg);
    }
  }
}
```

### 5.2 Framework Transport Files

Each framework SDK gets a single new file that implements
`UseStreamTransport` using `ProtocolClient`:

| Package | New file | Content |
|---------|----------|---------|
| `@langchain/react` | `src/protocol.tsx` | `ProtocolStreamTransport` for React `useStream` |
| `@langchain/vue` | `src/protocol.ts` | `ProtocolStreamTransport` for Vue `useStream` |
| `@langchain/svelte` | `src/protocol.ts` | `ProtocolStreamTransport` for Svelte `useStream` |
| `@langchain/angular` | `src/protocol.ts` | `ProtocolStreamTransport` for Angular stream service |

All four share the same pattern — a thin wrapper that:

1. Creates a `ProtocolClient` (WebSocket connection)
2. Subscribes to the appropriate channels
3. Translates protocol events into the `{ event, data }` SSE shape
   that `useStream`'s existing orchestrator expects
4. Exposes protocol-specific features (subscriptions, commands) as
   additional properties on the transport instance

```typescript
// Example: libs/sdk-react/src/protocol.tsx

import { ProtocolClient } from "@langchain/langgraph-sdk/protocol";
import type { UseStreamTransport } from "@langchain/langgraph-sdk/ui";

export class ProtocolStreamTransport<StateType, Bag>
  implements UseStreamTransport<StateType, Bag>
{
  private client: ProtocolClient;

  constructor(options: { url: string }) {
    this.client = new ProtocolClient(options);
  }

  async stream(payload) {
    // Subscribe to channels needed by useStream's orchestrator
    const sub = await this.client.subscribe(
      ["messages", "updates", "tools", "custom", "lifecycle"],
      { /* namespace options from payload */ }
    );

    // Yield events in the { event, data } shape useStream expects
    return (async function* () {
      for await (const event of sub) {
        yield {
          event: event.method,
          data: event.params.data,
        };
      }
    })();
  }

  // Additional protocol features exposed to the component
  get resource() { return this.client.resource; }
  get sandbox() { return this.client.sandbox; }
  get input() { return this.client.input; }
  get state() { return this.client.state; }
  get usage() { return this.client.usage; }
  get agent() { return this.client.agent; }
}
```

---

## 6. Existing Files Modified

These are the only changes to existing files. All are additive (new exports,
new config keys) — no existing signatures or behavior changes.

| File | Change | Lines |
|------|--------|-------|
| `langgraph-core/src/pregel/types.ts` | Add new `StreamMode` values to the union: `"lifecycle"`, `"resource"`, `"sandbox"`, `"input"`, `"state"`, `"usage"` | ~6 lines |
| `langgraph-core/src/pregel/index.ts` | Re-export `createSession` from `./protocol/index.js` | ~1 line |
| `langgraph-core/src/web.ts` | Add `./protocol` to exports | ~1 line |
| `langgraph-core/package.json` | Add `"./protocol"` subpath export | ~3 lines |
| `langgraph/src/protocol.ts` | New file: `export * from "@langchain/langgraph/protocol"` | ~1 line |
| `langgraph/package.json` | Add `"./protocol"` subpath export | ~3 lines |
| `sdk/package.json` | Add `"./protocol"` subpath export | ~3 lines |
| `sdk-react/package.json` | Add `"./protocol"` subpath export | ~3 lines |
| `sdk-vue/package.json` | Add `"./protocol"` subpath export | ~3 lines |
| `sdk-svelte/package.json` | Add `"./protocol"` subpath export | ~3 lines |
| `sdk-angular/package.json` | Add `"./protocol"` subpath export | ~3 lines |
| `langgraph-api/src/server.mts` | Mount v2 router: `app.route("/", v2)` | ~2 lines |

### What does NOT change

| File | Why untouched |
|------|---------------|
| `pregel/stream.ts` | `IterableReadableWritableStream`, `push()`, `toEventStream()` — all unchanged. v2 filtering happens outside the stream. |
| `pregel/loop.ts` | `createDuplexStream`, `_emit`, `putWrites` — all unchanged. v2 consumes the same chunks. |
| `pregel/runner.ts` | `tick`, `_commit` — all unchanged. Lifecycle events are emitted by the Session wrapper observing chunks, not by modifying the runner. |
| `pregel/messages.ts` | `StreamMessagesHandler` — unchanged. |
| `pregel/index.ts` | `_streamIterator` — unchanged (except the one-line re-export). v2 calls it internally with all modes enabled. |
| `sdk/src/client.ts` | v1 `Client` — unchanged. Protocol client is a new file. |
| `sdk-react/src/stream.tsx` | `useStream` hook — unchanged. Protocol transport plugs in via existing `transport` option. |
| `sdk-vue/src/index.ts` | `useStream` composable — unchanged. Same transport pattern. |
| `sdk-svelte/src/index.ts` | `useStream` store — unchanged. Same transport pattern. |
| `sdk-angular/src/index.ts` | Stream service — unchanged. Same transport pattern. |
| `langgraph-api/src/api/runs.mts` | v1 run streaming — unchanged. v2 has its own routes. |
| `langgraph-api/src/stream.mts` | v1 stream preprocessing — unchanged. |

---

## 7. Lifecycle Events Without Modifying the Runner

The design doc identified lifecycle events as requiring changes to
`PregelLoop` and `PregelRunner`. The v2 implementation avoids this by
deriving lifecycle events from existing stream chunks:

```typescript
// In protocol/channels/lifecycle.ts

export function deriveLifecycleEvents(chunk: StreamChunk): ProtocolEvent | null {
  const [namespace, mode, payload] = chunk;

  // "tasks" mode chunks with type="task" indicate task creation (≈ spawned)
  if (mode === "tasks" && isTaskCreate(payload)) {
    return {
      type: "event",
      method: "lifecycle",
      params: {
        namespace,
        timestamp: Date.now(),
        data: { event: "running", graphName: payload.name },
      },
    };
  }

  // "tasks" mode chunks with type="task_result" indicate completion
  if (mode === "tasks" && isTaskResult(payload)) {
    return {
      type: "event",
      method: "lifecycle",
      params: {
        namespace,
        timestamp: Date.now(),
        data: {
          event: payload.error ? "failed" : "completed",
          graphName: payload.name,
          error: payload.error,
        },
      },
    };
  }

  return null;
}
```

The `Session.startRun()` method checks each chunk for lifecycle derivation
and dispatches synthetic lifecycle events alongside the original chunk.
This means `"lifecycle"` is a derived channel — it doesn't require the
runtime to emit new event types. The `debug` / `tasks` modes already carry
the information; we just reshape it.

---

## 8. Channel Handler Architecture

Each extended module (resource, sandbox, input, state, usage) is a handler
class that:

1. Receives commands from the session or transport
2. Executes the operation (using existing LangGraph APIs)
3. Returns results or emits events

```typescript
// Generic handler interface
export interface ChannelHandler {
  handleCommand(method: string, params: unknown): Promise<unknown>;
}

// Example: InputHandler wraps interrupt/resume
export class InputHandler implements ChannelHandler {
  constructor(
    private graph: Pregel,
    private config: RunnableConfig,
    private dispatcher: EventDispatcher
  ) {}

  async handleCommand(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "input.respond":
        return this.respond(params as InputRespondParams);
      case "input.inject":
        return this.inject(params as InputInjectParams);
      default:
        throw new ProtocolError("unknown_command", method);
    }
  }

  private async respond(params: InputRespondParams): Promise<void> {
    // Internally creates a Command({ resume: params.response })
    // and sends it to the graph via the existing mechanism
  }
}
```

The session wires handlers to a command dispatch table:

```typescript
// In session.ts
private handlers: Map<string, ChannelHandler> = new Map([
  ["resource", new ResourceHandler(...)],
  ["sandbox", new SandboxHandler(...)],
  ["input", new InputHandler(...)],
  ["state", new StateHandler(...)],
  ["usage", new UsageHandler(...)],
]);

async handleCommand(command: ProtocolCommand): Promise<ProtocolResponse> {
  const [module] = command.method.split(".");
  const handler = this.handlers.get(module);
  if (!handler) throw new ProtocolError("unknown_command", command.method);
  const result = await handler.handleCommand(command.method, command.params);
  return { type: "success", id: command.id, result };
}
```

---

## 9. Testing Strategy

### Unit tests (new)

| Test file | Covers |
|-----------|--------|
| `protocol/registry.test.ts` | Namespace prefix matching, channel filtering, depth limits, subscribe/unsubscribe |
| `protocol/buffer.test.ts` | Ring buffer capacity, replay filtering, snapshot-drain ordering |
| `protocol/dispatcher.test.ts` | Chunk → ProtocolEvent conversion, multi-subscription dispatch, queue management |
| `protocol/session.test.ts` | createSession, subscribe/unsubscribe lifecycle, concurrent iterators, cleanup |
| `protocol/channels/lifecycle.test.ts` | Lifecycle derivation from tasks chunks |
| `protocol/channels/input.test.ts` | Interrupt → input.requested event, respond → Command({ resume }) |
| `protocol/channels/state.test.ts` | Store and checkpoint command passthrough |

### Integration tests (new)

| Test file | Covers |
|-----------|--------|
| `tests/protocol.test.ts` | Full session with real graph: subscribe to messages, see tokens; subscribe to lifecycle, see subagent spawn/complete; multiple concurrent subscriptions |
| `tests/protocol.int.test.ts` | Session with checkpointer: interrupt → input.requested → input.respond → resume; state.get; state.listCheckpoints; state.fork |

### Existing tests (unchanged)

All existing `pregel.test.ts`, `stream.test.ts`, `runner.test.ts`, and
integration tests continue to pass without modification. The v2 code is
additive and does not change any existing behavior.

---

## 10. Dependency Graph

```
@langchain/langgraph (langgraph-core)
  src/pregel/protocol/   ← NEW (depends on existing pregel internals)
       │
       │ imports from:
       ├── ../stream.ts     (StreamChunk type only)
       ├── ../types.ts      (StreamMode, PregelOptions)
       ├── ../index.ts      (Pregel class for _streamIterator)
       └── ../../interrupt.ts (interrupt, Command for input handler)

@langchain/langgraph-sdk
  src/protocol/          ← NEW (ProtocolClient, WebSocket transport)
       │
       └── imports from:
           └── @langchain/langgraph/protocol  (types only, for type sharing)

@langchain/react, @langchain/vue, @langchain/svelte, @langchain/angular
  src/protocol.*         ← NEW (ProtocolStreamTransport — 1 file each)
       │
       ├── imports from:
       │   ├── @langchain/langgraph-sdk/protocol  (ProtocolClient)
       │   └── @langchain/langgraph-sdk/ui        (UseStreamTransport interface)
       └── consumed by: existing useStream hooks via `transport` option

@langchain/langgraph-api
  src/api/v2/            ← NEW (depends on protocol + existing server infra)
       │
       ├── imports from:
       │   ├── @langchain/langgraph/protocol  (Session, types)
       │   └── ../runs.mts, ../threads.mts    (reuse auth, validation)
       └── mounted in: src/server.mts
```

No circular dependencies. The protocol directory imports from existing
pregel internals (one direction only). The SDK, framework transports, and
API server import the protocol types for type sharing but do not import
internal implementation. The framework transport files import from
`@langchain/langgraph-sdk/protocol` (the shared client) — they do not
import from `@langchain/langgraph` directly.

---

## 11. File Count Summary

| Category | New files | Modified files | Lines (est.) |
|----------|-----------|----------------|--------------|
| `langgraph-core` protocol | 12 | 4 | ~1,500 |
| `langgraph-api` v2 | 4 | 1 | ~400 |
| `sdk` protocol client | 4 | 1 | ~400 |
| Framework SDKs (React/Vue/Svelte/Angular) | 4 | 4 | ~400 |
| `langgraph` re-export | 1 | 1 | ~5 |
| Tests | 9 | 0 | ~1,200 |
| **Total** | **34** | **11** | **~3,900** |

The 11 modified files have a combined ~30 lines of actual changes (re-exports,
subpath exports, router mount, type union extension). The remaining ~3,870
lines are in new files that don't affect existing behavior.

---

## 12. Blockers and Risks

### 12.1 High Risk

**WebSocket support in Hono / deployment environments.** The `langgraph-api`
server uses [Hono](https://hono.dev/). Hono's WebSocket support varies by
runtime adapter: `@hono/node-server` has WebSocket via `upgradeWebSocket`,
but behavior differs across Deno, Cloudflare Workers, Bun, and other
targets. The protocol's primary transport is WebSocket, so any deployment
environment that doesn't support WebSocket upgrade from Hono will fall back
to the SSE + HTTP POST path — which works but loses the clean bidirectional
experience. We need to validate WebSocket upgrade behavior across all
deployment targets LangGraph supports before v2 launch.

**"All modes enabled" performance at extreme scale.** The v2 Session calls
`_streamIterator` with all 8 stream modes enabled and `subgraphs: true`.
For a run with 500 subagents, this means every LLM token, tool call, state
update, and debug trace from every subagent is produced as JS objects in
memory — even if the client only subscribed to `lifecycle` on the root
namespace. While the dispatcher discards unmatched events cheaply (no
serialization), the production overhead of all callback handlers
(`StreamMessagesHandler`, `StreamToolsHandler`) running for every subagent
may become a CPU bottleneck. If benchmarks show this is a problem, the
mitigation is to push subscription awareness down into `_emit` in
`PregelLoop` — but this is a significantly more invasive change that
touches the core pipeline.

**`_streamIterator` is private.** The Session calls `graph._streamIterator()`
directly, which is marked `@internal` and `override` (it comes from the
`Runnable` base class). If this method's signature or semantics change in a
future `@langchain/core` update, it could silently break the protocol
layer. We should either promote `_streamIterator` to a stable internal API
with a compatibility contract, or wrap it in a public method on `Pregel`
that the protocol layer uses instead.

### 12.2 Medium Risk

**Multi-consumer async iteration.** JavaScript's `ReadableStream` supports
only one reader at a time. The `Session.subscribe()` API returns
independent async iterators that consumers can use concurrently. This
requires a pub/sub fan-out pattern (one producer, N consumer queues).
Implementing this correctly — with proper backpressure, cleanup when
consumers unsubscribe or abandon iterators, and no memory leaks from
unconsumed queues — is subtle. An incorrect implementation can cause memory
leaks (events buffered in abandoned queues) or deadlocks (producer blocked
waiting for a slow consumer).

**`cddl2ts` output quality.** The
[`cddl2ts`](https://github.com/webdriverio/cddl/tree/main/packages/cddl2ts)
tool generates TypeScript interfaces from CDDL. Its output may not map
perfectly to our protocol's CDDL extensions (e.g., the `//=` augmentation
syntax, recursive types like `AgentTreeNode`). We may need to contribute
upstream fixes or maintain a thin post-processing step. Additionally,
`cddl2ts` only covers TypeScript — Python and Java type generation from
CDDL will require separate tooling that may not exist at the same maturity
level (Python has `cddlparser` but no codegen; Java has no established CDDL
toolchain).

**Interrupt/resume as in-band commands.** The `input.respond` command
wraps `Command({ resume })` and feeds it back into the graph. Today,
resume requires a new `invoke` or `stream` call on the graph — the graph
run has already completed (it threw `GraphInterrupt`) and must be
re-entered. The protocol's `input.respond` implies the connection stays
open and the graph resumes in the same session. This requires either:
(a) the session catches `GraphInterrupt`, waits for `input.respond`,
then re-enters the graph with the resume command — which means managing a
state machine around interrupt/resume within the session; or (b) changing
how `GraphInterrupt` propagation works so the graph can "pause" rather
than "throw." Option (a) is feasible but adds complexity to the session.
Option (b) is a deeper runtime change.

**Event buffer memory under high fan-out.** The `EventBuffer` stores
recent events for replay. With 500 subagents each producing 50 events/sec,
the buffer fills its default 1,000-event capacity in ~0.1 seconds. A
client that disconnects and reconnects after 5 seconds will have missed
~25,000 events — far beyond the buffer. The buffer capacity needs to be
configurable and the `subscription.reconnect` response must clearly
communicate whether full replay is possible. For long-running agents, a
checkpoint-based reconnection strategy (restore from latest checkpoint
rather than replaying events) may be more practical than event buffering.

### 12.3 Low Risk

**Framework SDK transport parity.** The four framework SDKs (React, Vue,
Svelte, Angular) each need a `ProtocolStreamTransport` implementation.
While the pattern is the same across all four, subtle differences in each
framework's reactivity model (React hooks vs Vue refs vs Svelte stores vs
Angular observables) may surface edge cases — especially around
subscription lifecycle cleanup when components unmount/remount. This is
testing-heavy but not architecturally risky.

**Binary frame parsing in browsers.** WebSocket binary frames arrive as
`ArrayBuffer` in browsers. Parsing the 16-byte header (4 x uint32) is
straightforward with `DataView`, but endianness must be explicitly
specified (network byte order / big-endian). This is easy to get wrong in
initial implementation and produces silent data corruption rather than
visible errors.

**Protocol versioning and evolution.** The CDDL schema defines the v2
protocol, but there is no built-in negotiation for future v3/v4 changes.
Adding an initial `session.capabilities` exchange (similar to BiDi's
capability negotiation but lighter) would future-proof the protocol, but
adds initial complexity. Risk of not doing this: breaking changes in
future versions require new URL prefixes (`/v3/`, `/v4/`).

**Python/Java parity.** This implementation plan covers TypeScript/JS only.
The same protocol needs to be implemented in LangGraph Python and (future)
LangGraph Java. The CDDL schema ensures type-level parity, but the runtime
architecture decisions (session wrapping `_stream_iterator`, dispatcher
pattern, transport abstraction) need to be independently implemented in
each language. Divergence in behavior across implementations could become a
support burden.

**Sandbox/resource handlers are deployment-specific.** The `resource.*` and
`sandbox.*` command handlers depend on access to the agent's execution
environment (file system, shell processes). For in-process execution, this
is Node.js `fs` and `child_process`. For agents running in remote sandboxes
(Modal, Daytona, E2B), these handlers need a bridge to the sandbox
provider's API. This bridge cannot be defined generically in
`langgraph-core` — it must be a pluggable adapter pattern where each
deployment backend (local, Modal, Daytona) provides its own resource/sandbox
handler implementation. The protocol defines the interface; the backend
provides the implementation.

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

// SDK: opt in via v2 client
import { Client } from "@langchain/langgraph-sdk/v2";

// Server: opt in via v2 endpoint prefix
// POST /v2/runs/stream  → WebSocket upgrade or SSE with subscriptions
// POST /runs/stream      → unchanged v1 behavior
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
│       └── v2/              ← NEW directory: v2 client
│
└── langgraph/               (langgraph — re-export wrapper)
    └── src/
        └── protocol.ts      ← NEW: re-export from core
```

### New subpath exports

| Package | Subpath | Content |
|---------|---------|---------|
| `@langchain/langgraph` | `./protocol` | `createSession`, `Session`, subscription types, protocol types |
| `@langchain/langgraph-sdk` | `./v2` | `ProtocolClient`, typed subscription methods |
| `@langchain/langgraph-api` | `./v2` | v2 route handlers (WebSocket + SSE) |
| `langgraph` | `./protocol` | Re-export from `@langchain/langgraph/protocol` |

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

Protocol-level types derived from the CDDL schema. These are the TypeScript
equivalent of what CDDL codegen would produce:

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

## 5. New Files in `sdk`

The SDK gets a v2 client that understands the protocol.

```
libs/sdk/src/v2/
├── index.ts                 Entry point — exports ProtocolClient
├── client.ts                ProtocolClient — WebSocket or SSE connection
├── subscription.ts          Typed subscription iterators
└── types.ts                 v2-specific types
```

### 5.1 `v2/client.ts` — ProtocolClient

```typescript
export class ProtocolClient {
  private ws: WebSocket;
  private commandId: number = 0;
  private pending: Map<number, { resolve, reject }> = new Map();

  constructor(options: { url: string }) {
    this.ws = new WebSocket(options.url);
    this.ws.onmessage = (event) => this.handleMessage(event);
  }

  /**
   * Subscribe to channels on specific namespaces.
   * Returns a typed async iterable.
   */
  async subscribe(
    channels: Channel[],
    options?: SubscribeOptions
  ): Promise<ProtocolSubscription> {
    const result = await this.sendCommand("subscription.subscribe", {
      channels,
      ...options,
    });
    return new ProtocolSubscription(result.subscriptionId, this);
  }

  // Typed command methods matching the in-process Session API
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
      // Binary frame — dispatch to media subscription
      this.handleBinaryFrame(event.data);
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.type === "success" || msg.type === "error") {
      // Command response
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        msg.type === "success" ? pending.resolve(msg.result) : pending.reject(msg);
      }
    } else if (msg.type === "event") {
      // Dispatch to matching subscription iterators
      this.dispatchEvent(msg);
    }
  }
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
| `sdk/package.json` | Add `"./v2"` subpath export | ~3 lines |
| `langgraph-api/src/server.mts` | Mount v2 router: `app.route("/", v2)` | ~2 lines |

### What does NOT change

| File | Why untouched |
|------|---------------|
| `pregel/stream.ts` | `IterableReadableWritableStream`, `push()`, `toEventStream()` — all unchanged. v2 filtering happens outside the stream. |
| `pregel/loop.ts` | `createDuplexStream`, `_emit`, `putWrites` — all unchanged. v2 consumes the same chunks. |
| `pregel/runner.ts` | `tick`, `_commit` — all unchanged. Lifecycle events are emitted by the Session wrapper observing chunks, not by modifying the runner. |
| `pregel/messages.ts` | `StreamMessagesHandler` — unchanged. |
| `pregel/index.ts` | `_streamIterator` — unchanged (except the one-line re-export). v2 calls it internally with all modes enabled. |
| `sdk/src/client.ts` | v1 `Client` — unchanged. v2 client is a new file. |
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
  src/v2/                ← NEW (depends on protocol types)
       │
       └── imports from:
           └── @langchain/langgraph/protocol  (types only, for type sharing)

@langchain/langgraph-api
  src/api/v2/            ← NEW (depends on protocol + existing server infra)
       │
       ├── imports from:
       │   ├── @langchain/langgraph/protocol  (Session, types)
       │   └── ../runs.mts, ../threads.mts    (reuse auth, validation)
       └── mounted in: src/server.mts
```

No circular dependencies. The protocol directory imports from existing
pregel internals (one direction only). The SDK and API server import the
protocol types for type sharing but do not import internal implementation.

---

## 11. File Count Summary

| Category | New files | Modified files | Lines (est.) |
|----------|-----------|----------------|--------------|
| `langgraph-core` protocol | 12 | 4 | ~1,500 |
| `langgraph-api` v2 | 4 | 1 | ~400 |
| `sdk` v2 | 4 | 1 | ~500 |
| `langgraph` re-export | 1 | 1 | ~5 |
| Tests | 9 | 0 | ~1,200 |
| **Total** | **30** | **7** | **~3,600** |

The 7 modified files have a combined ~17 lines of actual changes (re-exports,
subpath exports, router mount, type union extension). The remaining ~3,583
lines are in new files that don't affect existing behavior.

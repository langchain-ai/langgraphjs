# Agent Streaming Protocol: Design Analysis & Recommendation

> **Status**: RFC / Design Document  
> **Author**: LangGraph.js Team  
> **Date**: 2026-03-26

## Table of Contents

- [1. Problem Statement](#1-problem-statement)
- [2. Current Streaming Architecture](#2-current-streaming-architecture)
- [3. Protocol Landscape](#3-protocol-landscape)
  - [3.1 WebDriver BiDi](#31-webdriver-bidi)
  - [3.2 A2A (Agent-to-Agent)](#32-a2a-agent-to-agent)
  - [3.3 ACP (Agent Communication Protocol)](#33-acp-agent-communication-protocol)
- [4. Why WebDriver BiDi Is the Right Structural Model](#4-why-webdriver-bidi-is-the-right-structural-model)
- [5. Why Not A2A or ACP](#5-why-not-a2a-or-acp)
- [6. Proposed Protocol Design](#6-proposed-protocol-design)
- [7. Migration Path](#7-migration-path)

---

## 1. Problem Statement

LangGraph agents can orchestrate complex hierarchies of subagents. In production
scenarios, a single root agent may spawn **hundreds of concurrent subagents**,
each producing streaming output (LLM tokens, tool calls, state updates, custom
events). The frontend needs to consume this data in real time without performance
degradation.

The current streaming architecture has several bottlenecks at this scale:

| Problem | Impact |
|---------|--------|
| **Single multiplexed stream** | All subagents share one `IterableReadableWritableStream`. Consumers must parse every chunk to find relevant data. |
| **No server-side filtering** | Clients cannot subscribe to specific subagent namespaces or event types—they receive everything and filter locally. |
| **No backpressure per subagent** | A slow consumer blocks or buffers the entire stream; there is no per-namespace flow control. |
| **Duplex fan-out overhead** | `createDuplexStream` iterates all duplexed streams on every push, adding O(N) overhead per chunk where N is nesting depth. |
| **Checkpoint serialization** | `_checkpointerPutAfterPrevious` chains writes sequentially, creating a throughput bottleneck with many subgraphs. |
| **Callback handler memory** | `StreamMessagesHandler` / `StreamToolsHandler` keep per-run maps that grow linearly with concurrent LLM/tool runs. |

---

## 2. Current Streaming Architecture

### Internal Protocol

The current protocol uses a simple tuple format:

```typescript
type StreamChunk = [namespace: string[], mode: StreamMode, payload: unknown];

type StreamMode =
  | "values"    // Full state after each step
  | "updates"   // Per-node state deltas
  | "debug"     // Verbose execution traces
  | "messages"  // LLM token streaming
  | "checkpoints"
  | "tasks"
  | "custom"    // User-defined payloads via getWriter()
  | "tools";    // Tool lifecycle events
```

### Subgraph Namespace Propagation

Nested graphs use `checkpoint_ns` (separated by `CHECKPOINT_NAMESPACE_SEPARATOR`)
to build a hierarchical namespace. The parent injects its stream via
`CONFIG_KEY_STREAM` so child graphs can push into the same stream:

```
root
├── agent_1                    → namespace: ["agent_1"]
│   ├── researcher             → namespace: ["agent_1", "researcher"]
│   └── writer                 → namespace: ["agent_1", "writer"]
├── agent_2                    → namespace: ["agent_2"]
│   ├── analyst:0              → namespace: ["agent_2", "analyst:0"]
│   └── analyst:1              → namespace: ["agent_2", "analyst:1"]
...
└── agent_N                    → namespace: ["agent_N"]
```

### SSE Encoding

`toEventStream` converts chunks to SSE with the event name encoding both mode
and namespace:

```
event: messages|agent_1|researcher
data: [{"content":"Hello","type":"ai"}, {"langgraph_node":"researcher"}]

event: tools|agent_2|analyst:0
data: {"event":"on_tool_start","name":"search","input":{"q":"..."}}
```

This design works adequately for shallow hierarchies with a handful of subagents
but degrades at scale.

---

## 3. Protocol Landscape

### 3.1 WebDriver BiDi

**What it is**: A W3C standard for bidirectional browser remote control over
WebSocket, replacing the unidirectional HTTP-based WebDriver Classic.

**Key design patterns**:

| Pattern | Description |
|---------|-------------|
| **Bidirectional WebSocket** | Full-duplex communication; commands flow client→server, events flow server→client concurrently. |
| **Modular architecture** | Protocol is split into modules (`browsingContext`, `script`, `network`, etc.), each defining its own commands and events. |
| **Subscription-based events** | Clients call `session.subscribe({events: ["network.responseStarted"], contexts: ["ctx-123"]})` to receive only relevant events. Server-side filtering reduces wire traffic. |
| **Per-context scoping** | Events can be scoped to specific browsing contexts (analogous to subagent namespaces). |
| **Async command IDs** | Commands carry an `id`; responses reference it. Multiple commands can be in-flight simultaneously. |
| **CDDL-defined messages** | Formal schema for all protocol messages. |
| **Session lifecycle** | Explicit session creation, capability negotiation, and teardown. |

**Relevance to agent streaming**: The browsing context tree in WebDriver BiDi
is structurally analogous to a subagent hierarchy. The subscription + context
scoping pattern directly maps to "subscribe to events from subagent X".

### 3.2 A2A (Agent-to-Agent)

**What it is**: Google-initiated open protocol (now under Linux Foundation) for
inter-agent communication. Current version: 1.0.0.

**Key design patterns**:

| Pattern | Description |
|---------|-------------|
| **JSON-RPC 2.0 over HTTP** | Request/response with standard error codes. |
| **Task lifecycle** | Stateful `Task` objects with states: `submitted` → `working` → `completed` / `failed` / `canceled` / `input-required`. |
| **SSE streaming** | `message/stream` endpoint returns `text/event-stream` with `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent`. |
| **Push notifications** | Webhook-based async notifications for long-running tasks. |
| **Agent Cards** | JSON metadata at `/.well-known/agent.json` for capability discovery. |
| **Opaque execution** | Agents do not share internal state, tools, or prompts—only inputs/outputs. |
| **Resubscription** | `tasks/resubscribe` allows reconnecting to an active task stream after disconnect. |

**Relevance to agent streaming**: A2A is designed for **inter-agent**
communication across organizational boundaries. Its opaque execution model
means it intentionally hides the internal streaming data (LLM tokens, tool
calls, intermediate state) that a frontend needs to display.

### 3.3 ACP (Agent Communication Protocol)

**What it is**: Originally from IBM's BeeAI project, ACP was a REST-based
agent communication protocol. As of 2025, **ACP has merged into A2A under the
Linux Foundation** and active development has wound down.

**Key design patterns**:

| Pattern | Description |
|---------|-------------|
| **REST-based** | Standard HTTP conventions, no SDK required. |
| **Async-first** | Non-blocking communication patterns. |
| **Offline discovery** | Agent capability discovery without persistent connectivity. |
| **Vendor-neutral** | Framework-agnostic execution model. |

**Relevance to agent streaming**: ACP's merger into A2A makes it largely
redundant as a separate consideration. Its REST-based simplicity is subsumed
by A2A's JSON-RPC approach.

---

## 4. Why WebDriver BiDi Is the Right Structural Model

### The Core Insight

WebDriver BiDi solved the same fundamental problem in a different domain: a
**tree of concurrent contexts** (browser tabs, iframes, workers) producing
**heterogeneous event streams** (network, DOM, console, script) that a remote
client needs to observe **selectively**. Before BiDi, WebDriver Classic was
request/response only — the client had to poll for changes, exactly like
our current `subgraphs: true` all-or-nothing streaming.

The structural mapping between domains is direct:

| WebDriver BiDi | Agent Streaming Protocol |
|----------------|--------------------------|
| Browser session | Agent run / thread |
| Browsing context tree | Subagent namespace tree (`checkpoint_ns`) |
| Modules (`network`, `script`, `log`) | Channels (`messages`, `tools`, `updates`, `custom`) |
| `session.subscribe` with context filter | Subscribe to channels on specific namespace prefixes |
| Events scoped to browsing context | Events scoped to namespace |
| Async command IDs | Concurrent command tracking |
| WebSocket transport | WebSocket (primary) + SSE + in-process |

This is not a loose analogy. The context tree → subscription → filtered events
pipeline is exactly the architecture we need, adapted to different domain
primitives.

### BiDi Patterns We Adopt Directly

1. **Subscription-based event filtering** — the single most impactful pattern.
   BiDi clients call `session.subscribe({events: ["network.responseStarted"],
   contexts: ["ctx-123"]})` and the server filters at the source. Our protocol
   does the same: subscribe to `messages` on namespace `["agent_1"]` and
   receive only matching events. A client watching 1 subagent out of 200
   never sees the other 199.

2. **Bidirectional communication** — BiDi uses WebSocket so the client can
   adjust subscriptions while events flow. Our protocol does the same:
   subscribe to new subagents as they spawn, unsubscribe from completed ones,
   all without interrupting the event stream.

3. **Module-based extensibility** — BiDi organizes protocol surface into
   modules, each defining its own commands and events. Our protocol maps
   this to channels (stream modes), giving a principled extension mechanism.
   Adding a new event type means adding a new channel, not changing the
   protocol framing.

4. **Context tree discovery** — BiDi provides `browsingContext.getTree()` to
   inspect the context hierarchy. Our protocol provides `agent.getTree()` to
   inspect the subagent namespace hierarchy. Both enable clients to understand
   the current structure before subscribing.

5. **Per-context scoping with subscription IDs** — BiDi returns a subscription
   ID from `session.subscribe` and supports targeted `session.unsubscribe`.
   Our protocol mirrors this exactly.

6. **Command/response framing with concurrent commands** — BiDi commands carry
   a numeric `id` and responses reference it, allowing multiple commands
   in-flight. Our protocol uses the same framing for subscription management
   and hierarchy queries.

### Adaptations for the Agent Domain

We follow BiDi's structure but adapt the following for the agent streaming
domain:

| Aspect | BiDi | Our Adaptation | Rationale |
|--------|------|----------------|-----------|
| **Transport** | WebSocket only | WebSocket + SSE + in-process | Agent streaming must work in serverless/edge (no WebSocket) and in-process (zero serialization overhead). |
| **Specification style** | CDDL formal grammar, 300+ pages | TypeScript types + JSON Schema, focused spec | We control both ends; formal grammar adds friction without interop benefit. |
| **Context tree** | Browsing contexts, realms, navigations | Namespace tree with lifecycle states | Agent namespaces need lifecycle tracking (`spawned` → `running` → `completed` / `failed`), which BiDi contexts do not have. |
| **Event volume** | Moderate (DOM/network events) | Very high (LLM tokens at hundreds of concurrent streams) | Requires backpressure and flow control not present in BiDi. |
| **Reconnection** | Session restore (full state) | Event buffer + selective replay | Agent runs can be long-lived; full state replay is impractical, bounded event buffers are practical. |
| **Capability negotiation** | Complex `session.new` capabilities object | Minimal — transport selection is sufficient | No cross-vendor interop requirement eliminates capability negotiation complexity. |

The lifecycle states and reconnection mechanisms draw on patterns proven in
A2A's task state machine (`submitted` → `working` → `completed` / `failed`)
and `tasks/resubscribe`. These fill a gap that BiDi's session model does not
address: long-running tasks with observable state transitions.

---

## 5. Why Not A2A or ACP

A2A and ACP (now merged into A2A) are the other major agent protocol efforts.
They were designed for a fundamentally different problem.

### Wrong Abstraction Level

A2A is an **inter-agent** protocol for cross-organization communication. Its
core principle is **opaque execution** — agents collaborate without sharing
internal state, tools, or prompts. Only inputs and outputs cross the boundary.

Our problem is **intra-system observability**. We own both the agent runtime
and the frontend, and we explicitly need to expose internal execution details:
every LLM token, every tool call, every state mutation, for the specific
subagents the user is watching. Opaque execution is the opposite of what we
need.

### No Namespace Hierarchy

A2A tasks are flat, identified by a single task ID. There is no concept of a
task tree, nested scoping, or hierarchical subscriptions. Agent streaming needs
to represent and navigate `root → agent_1 → researcher → llm_call` as a
queryable tree — exactly what BiDi's context tree provides.

### Unidirectional Streaming

A2A streaming uses SSE, which is server→client only. The client cannot
dynamically adjust subscriptions without making separate HTTP requests to a
control endpoint. BiDi's WebSocket model — where subscription commands and
events share a single bidirectional connection — is a better fit for
interactive subscription management at high fan-out.

### What We Do Take From A2A

Two A2A patterns are worth incorporating because they address gaps in BiDi's
model:

| Pattern | Why |
|---------|-----|
| **Task lifecycle states** | BiDi browsing contexts don't have lifecycle state machines. Subagents need `spawned` → `running` → `completed` / `failed` / `interrupted` states so the frontend can track progress and clean up subscriptions. |
| **Resubscription** | `tasks/resubscribe` allows reconnecting to an active stream after disconnect. BiDi assumes persistent WebSocket sessions; agent runs can outlive connection lifetimes. |

These augment the BiDi structure rather than replacing it.

---

## 6. Proposed Protocol Design

The protocol follows WebDriver BiDi's architecture — bidirectional connection,
subscription-based event delivery, modular channels, hierarchical context
scoping — adapted to the agent execution domain with lifecycle tracking,
multi-transport support, and high-throughput flow control.

### 6.1 Transport Layer

The protocol is transport-agnostic with three supported transports:

```
┌─────────────────────────────────────────────────┐
│              Agent Streaming Protocol            │
├────────────┬────────────────┬────────────────────┤
│  WebSocket │      SSE       │    In-Process      │
│  (bidi)    │  (server→client│  (async iterator)  │
│            │   + HTTP POST  │                    │
│            │   for commands)│                    │
└────────────┴────────────────┴────────────────────┘
```

- **WebSocket**: Full bidirectional. Client sends subscription commands,
  server pushes events. Preferred for interactive frontends.
- **SSE + HTTP**: Server pushes events via SSE. Client manages subscriptions
  via HTTP POST to a control endpoint. Works in serverless/edge environments.
- **In-Process**: Direct `AsyncIterableIterator` consumption with a
  programmatic subscription API. Zero serialization overhead.

### 6.2 Message Format

Messages follow BiDi's three-type framing: **commands** (client → server),
**command responses** (server → client), and **events** (server → client).
Like BiDi, commands carry a numeric `id` for correlation and can be in-flight
concurrently:

```typescript
// Client → Server (commands)
interface ProtocolCommand {
  id: number;                    // Client-assigned, for correlating responses
  method: string;                // e.g., "subscription.subscribe"
  params: Record<string, unknown>;
}

// Server → Client (command responses)
interface ProtocolResponse {
  id: number;                    // Matches the command ID
  result?: unknown;
  error?: { code: string; message: string };
}

// Server → Client (events)
interface ProtocolEvent {
  method: string;                // e.g., "agent.stateUpdate"
  params: {
    namespace: string[];         // Subagent hierarchy path
    timestamp: number;           // Server timestamp (ms)
    data: unknown;               // Event-specific payload
  };
}
```

### 6.3 Namespace Model

Namespaces are hierarchical arrays representing the subagent tree:

```
[]                           → root agent
["agent_1"]                  → first-level subagent
["agent_1", "researcher"]   → nested subagent
["agent_1", "researcher:2"] → second instance of "researcher" subgraph
```

Namespace subscriptions support **prefix matching**: subscribing to
`["agent_1"]` receives events from `["agent_1"]`, `["agent_1", "researcher"]`,
and all deeper descendants.

### 6.4 Subscription Management

Follows BiDi's `session.subscribe` / `session.unsubscribe` pattern, with
channels (our modules) and namespaces (our browsing contexts) as the two
filtering dimensions:

```typescript
// Subscribe to specific channels on specific namespaces
{
  id: 1,
  method: "subscription.subscribe",
  params: {
    channels: ["messages", "tools"],       // Stream modes to receive
    namespaces: [["agent_1"]],             // Prefix-match these namespaces
    depth: 2                               // Max depth below prefix (optional)
  }
}

// Response includes a subscription ID for later unsubscribe
{
  id: 1,
  result: { subscriptionId: "sub_abc123" }
}

// Unsubscribe
{
  id: 2,
  method: "subscription.unsubscribe",
  params: { subscriptionId: "sub_abc123" }
}

// Subscribe to all events globally (equivalent to current behavior)
{
  id: 3,
  method: "subscription.subscribe",
  params: { channels: ["values", "updates", "messages", "tools", "custom"] }
}
```

**Server-side filtering**: The server maintains a subscription registry per
connection. When a `StreamChunk` is produced internally, the server checks it
against active subscriptions before serializing and sending. This is the key
performance optimization: chunks that no client has subscribed to are **never
serialized or transmitted**.

### 6.5 Event Channels (Modules)

Channels map to the existing `StreamMode` values plus new lifecycle events:

| Channel | Description | Payload Shape |
|---------|-------------|---------------|
| `values` | Full state after each step | `{ values: Record<string, unknown> }` |
| `updates` | Per-node state deltas | `{ node: string, updates: Record<string, unknown> }` |
| `messages` | LLM token streaming | `{ message: BaseMessage, metadata: Record<string, unknown> }` |
| `tools` | Tool lifecycle events | `{ event: "start"\|"end"\|"error", name: string, ... }` |
| `custom` | User-defined payloads | `unknown` |
| `lifecycle` | **New**: Subagent lifecycle | `{ event: "spawned"\|"running"\|"completed"\|"failed"\|"interrupted", agentId: string }` |
| `debug` | Verbose execution traces | `Record<string, unknown>` |
| `checkpoints` | Checkpoint metadata | `{ values, next, config, metadata, ... }` |

The `lifecycle` channel is new and inspired by A2A's task lifecycle. It enables
the frontend to:
- Know when new subagents spawn (dynamically subscribe to them)
- Track which subagents are active vs. completed
- Display a real-time hierarchy view of the agent tree

### 6.6 Backpressure and Flow Control

For high fan-out scenarios, the protocol includes flow control mechanisms:

```typescript
// Client can signal buffer capacity
{
  id: 4,
  method: "flow.setCapacity",
  params: {
    maxBufferSize: 256,        // Max queued events before server drops/pauses
    strategy: "drop-oldest"    // or "pause-producer" or "sample"
  }
}
```

**Strategies**:

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `drop-oldest` | When buffer is full, discard oldest undelivered events | Dashboard/monitoring UI |
| `pause-producer` | Apply backpressure to the stream (slow down production) | Debugging / detailed analysis |
| `sample` | Deliver every Nth event when under pressure, with a summary count | High-volume LLM token streams |

### 6.7 Reconnection and Resubscription

Inspired by A2A's `tasks/resubscribe`, the protocol supports reconnection:

```typescript
// On reconnect, client sends its last known position
{
  id: 5,
  method: "subscription.reconnect",
  params: {
    runId: "run_xyz",
    lastEventId: "evt_456",          // Last event the client processed
    subscriptions: ["sub_abc123"]    // Restore these subscriptions
  }
}

// Server responds with current state + missed events (if available)
{
  id: 5,
  result: {
    restored: true,
    missedEvents: 12,                // Number of events replayed
    currentNamespaces: [             // Active subagent tree
      { namespace: ["agent_1"], status: "running" },
      { namespace: ["agent_1", "researcher"], status: "completed" },
      { namespace: ["agent_2"], status: "running" }
    ]
  }
}
```

This requires a bounded event buffer on the server (configurable, default
1000 events). Events beyond the buffer are lost; the server signals this
with `restored: false` and the client can request a full state snapshot.

### 6.8 Hierarchy Discovery

Before subscribing, clients can discover the current agent tree:

```typescript
// Request current namespace hierarchy
{
  id: 6,
  method: "agent.getTree",
  params: { runId: "run_xyz" }
}

// Response
{
  id: 6,
  result: {
    tree: {
      namespace: [],
      status: "running",
      graphName: "supervisor",
      children: [
        {
          namespace: ["agent_1"],
          status: "running",
          graphName: "research_agent",
          children: [
            { namespace: ["agent_1", "researcher"], status: "completed", graphName: "web_search" },
            { namespace: ["agent_1", "writer"], status: "running", graphName: "content_writer" }
          ]
        },
        {
          namespace: ["agent_2"],
          status: "running",
          graphName: "analysis_agent",
          children: []
        }
      ]
    }
  }
}
```

---

## 7. Migration Path

### Phase 1: Server-Side Filtering (Non-Breaking)

Add subscription-based filtering to the existing SSE transport. Clients that
don't send subscriptions receive all events (current behavior). Clients that
subscribe receive only matching events.

**Changes required**:
- New `SubscriptionRegistry` class in `pregel/stream.ts`
- Modify `toEventStream` to check subscriptions before emitting
- Add HTTP POST endpoint for subscription management (SSE transport)

### Phase 2: WebSocket Transport

Add WebSocket as an alternative transport alongside SSE. The same protocol
messages work on both transports; WebSocket simply enables bidirectional
communication without a separate HTTP control channel.

**Changes required**:
- New `WebSocketStreamTransport` class
- Protocol message serialization/deserialization
- Connection lifecycle management

### Phase 3: Lifecycle Channel and Hierarchy Discovery

Add the `lifecycle` event channel and `agent.getTree` command. This enables
dynamic subscription UIs where the frontend discovers the subagent tree and
subscribes to specific branches.

**Changes required**:
- Emit lifecycle events from `PregelLoop` when tasks start/complete
- Maintain a namespace tree structure in `PregelRunner`
- Implement `agent.getTree` command handler

### Phase 4: Backpressure and Reconnection

Add flow control and reconnection support. This is the most invasive change,
requiring a bounded event buffer and per-connection flow control state.

**Changes required**:
- Event buffer with configurable retention
- Per-connection backpressure state in `IterableReadableWritableStream`
- Reconnection protocol implementation

---

## Appendix A: Protocol Comparison Matrix

| Dimension | Current LangGraph | WebDriver BiDi | A2A | **Proposed (BiDi-modeled)** |
|-----------|------------------|----------------|-----|---------------------------|
| **Transport** | SSE / in-process | WebSocket | HTTP + SSE | WebSocket + SSE + in-process |
| **Direction** | Unidirectional | Bidirectional | Unidirectional (SSE) + HTTP | Bidirectional (WS) / Uni + HTTP (SSE) |
| **Filtering** | Client-side | Server-side (subscription) | None (per-task streams) | Server-side (subscription) — same as BiDi |
| **Namespace model** | Flat array (checkpoint_ns) | Context tree | Flat (task ID) | Hierarchical namespace tree — adapted from BiDi context tree |
| **Scoping** | All-or-nothing (subgraphs: true/false) | Per-context + per-module | Per-task | Per-namespace + per-channel + depth — mirrors BiDi scoping |
| **Lifecycle** | Implicit (stream end) | Session lifecycle | Task state machine | Subagent lifecycle events — extends BiDi with A2A-style states |
| **Backpressure** | None | None | None | Configurable per-connection — new for high-throughput agents |
| **Reconnection** | None | Session restore | tasks/resubscribe | Event buffer + reconnect — adapted from A2A |
| **Discovery** | None | browsingContext.getTree | Agent Cards | agent.getTree — adapted from BiDi |
| **Schema** | TypeScript types | CDDL | JSON Schema / OpenAPI | TypeScript types + JSON Schema |

## Appendix B: Performance Estimates

For a scenario with 200 concurrent subagents, each producing ~50 events/second:

| Metric | Current | With Server-Side Filtering |
|--------|---------|---------------------------|
| Events produced (server) | 10,000/s | 10,000/s (unchanged) |
| Events serialized | 10,000/s | ~50-500/s (per subscription) |
| Wire traffic | ~5 MB/s | ~25-250 KB/s |
| Client parse overhead | 10,000 JSON.parse/s | ~50-500 JSON.parse/s |
| Memory (client) | All events buffered | Only subscribed events |

The 20-200x reduction in client-side processing is the primary performance win,
achieved by server-side subscription filtering alone (Phase 1).

## Appendix C: Comparison to Existing Streaming Systems

### Why Not Just Use GraphQL Subscriptions?

GraphQL subscriptions offer field-level filtering and are a viable transport
option. However, they add a query language layer that is unnecessary when the
event schema is well-defined and the filtering model is namespace + channel
based. The proposed protocol is simpler, has no query parsing overhead, and
maps directly to LangGraph's internal concepts.

### Why Not gRPC Streaming?

gRPC bidirectional streaming would work well technically but limits browser
compatibility (requires gRPC-Web proxy), adds protobuf compilation steps, and
conflicts with the existing SSE-based ecosystem. The proposed protocol achieves
similar capabilities over standard WebSocket/HTTP.

### Relationship to Model Context Protocol (MCP)

MCP connects agents to tools and data sources. It is complementary to this
protocol—MCP handles tool/resource access while the agent streaming protocol
handles real-time execution observability. They operate at different layers
and do not conflict.

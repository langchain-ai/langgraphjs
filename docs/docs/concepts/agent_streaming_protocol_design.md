# Agent Streaming Protocol: Design Analysis & Recommendation

> **Status**: RFC / Design Document  
> **Author**: LangGraph.js Team  
> **Date**: 2026-03-26

## Table of Contents

- [1. Problem Statement](#1-problem-statement)
- [2. Current Streaming Architecture](#2-current-streaming-architecture)
- [3. Protocol Comparison](#3-protocol-comparison)
  - [3.1 WebDriver BiDi](#31-webdriver-bidi)
  - [3.2 A2A (Agent-to-Agent)](#32-a2a-agent-to-agent)
  - [3.3 ACP (Agent Communication Protocol)](#33-acp-agent-communication-protocol)
- [4. Analysis of the WebDriver BiDi Approach](#4-analysis-of-the-webdriver-bidi-approach)
- [5. Recommended Approach](#5-recommended-approach)
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

## 3. Protocol Comparison

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

## 4. Analysis of the WebDriver BiDi Approach

### What Makes BiDi a Strong Analogy

The intuition to model agent streaming after WebDriver BiDi is well-founded.
The structural parallels are strong:

| WebDriver BiDi | Agent Streaming |
|----------------|-----------------|
| Browser session | Agent run / thread |
| Browsing context tree | Subagent hierarchy (namespace tree) |
| Modules (network, script, DOM) | Stream modes (messages, tools, updates, custom) |
| `session.subscribe` with context filter | Subscribe to specific subagent + event type |
| Events scoped to context | Events scoped to namespace |
| Async command IDs | Concurrent subagent task tracking |
| WebSocket transport | WebSocket transport |

### Where BiDi Fits Well

1. **Subscription-based filtering** is the single most impactful pattern for
   high fan-out scenarios. Today, a client watching 1 subagent out of 200 still
   receives all 200 subagents' events. Server-side filtering based on
   subscriptions would reduce wire traffic by orders of magnitude.

2. **Bidirectional communication** enables the client to dynamically adjust
   subscriptions as the agent hierarchy evolves—subscribing to new subagents
   as they spawn, unsubscribing from completed ones.

3. **Module-based organization** maps cleanly to LangGraph's existing stream
   modes, giving a principled way to extend the protocol with new event types.

4. **Per-context scoping** directly translates to per-namespace scoping in
   LangGraph's checkpoint namespace system.

### Where BiDi Does Not Fit

1. **Complexity budget**: WebDriver BiDi is a 300+ page specification designed
   for browser automation across vendors. Agent streaming does not need CDDL
   formal grammars, capability negotiation matrices, or the full session
   lifecycle complexity. Over-engineering the protocol would slow adoption.

2. **Transport assumption**: BiDi mandates WebSocket. Agent streaming must also
   support SSE (for environments where WebSocket is unavailable, e.g., some
   serverless platforms, CDN edge functions) and in-process consumption (the
   common case for LangGraph.js where graph and consumer share a process).

3. **Command model**: BiDi's command/response model (with numeric IDs and
   out-of-order responses) is designed for browser automation commands. Agent
   streaming is primarily **event-driven**—the main interaction pattern is
   "subscribe and receive events," not "send commands and await responses."

4. **No task lifecycle**: BiDi has no concept of task state machines. Agent
   streaming needs to know when a subagent is `running`, `waiting`, `completed`,
   or `failed`—this is where A2A's task lifecycle is more relevant.

---

## 5. Recommended Approach

### Hybrid Protocol: BiDi-Inspired Subscriptions + A2A-Inspired Task Lifecycle

Neither WebDriver BiDi, A2A, nor ACP should be adopted wholesale. Instead,
the agent streaming protocol should **selectively adopt the strongest patterns**
from each:

| Pattern | Source | Rationale |
|---------|--------|-----------|
| **Subscription-based event filtering** | WebDriver BiDi | Core mechanism for solving high fan-out. Server filters at source, client receives only what it asked for. |
| **Hierarchical namespace scoping** | WebDriver BiDi (context tree) + LangGraph (checkpoint_ns) | Already exists in LangGraph; formalize it as a first-class protocol concept like BiDi's browsing contexts. |
| **Module/channel separation** | WebDriver BiDi (modules) | Map to stream modes. Subscribe to `messages` from one subagent and `tools` from another. |
| **Task lifecycle states** | A2A | Subagents have observable lifecycle states (`spawned` → `running` → `completed` / `failed` / `interrupted`). |
| **Resubscription / reconnection** | A2A | Allow clients to reconnect to an active run and resume receiving events from the last known position. |
| **Transport agnosticism** | Original design | Support WebSocket (bidirectional), SSE (unidirectional), and in-process (direct async iteration). |
| **JSON-RPC-like framing** | A2A | Lightweight request/response framing for subscription management, not a full JSON-RPC implementation. |

### Why NOT Adopt A2A or ACP Directly

1. **Wrong abstraction level**: A2A/ACP are **inter-agent** protocols designed
   for cross-organization agent collaboration with opaque execution. Our problem
   is **intra-system streaming**—we own both the agent runtime and the frontend,
   and we explicitly need to expose internal execution details (LLM tokens,
   tool calls, state mutations).

2. **Opaque execution is the opposite of what we need**: A2A intentionally
   hides agent internals. A frontend streaming protocol needs to expose the
   full execution trace—every token, every tool call, every state update—for
   the specific subagents the user is watching.

3. **No namespace hierarchy**: A2A tasks are flat. There is no concept of a
   task tree or hierarchical scoping. Agent streaming needs to represent
   `root → agent_1 → researcher → llm_call` as a navigable hierarchy.

4. **SSE-only streaming**: A2A's streaming is SSE-only and unidirectional. The
   client cannot dynamically adjust what it's subscribed to without making
   separate HTTP requests. For real-time subscription management in high
   fan-out scenarios, bidirectional communication is strongly preferred.

### Why NOT Adopt WebDriver BiDi Directly

1. **Excessive specification surface**: BiDi defines 9+ modules, 50+ commands,
   and 30+ event types for browser automation. Agent streaming needs ~5 event
   channels and ~4 subscription management operations.

2. **Wrong domain model**: BiDi's primitives are browsing contexts, realms,
   and navigation. Translating these to agents, tasks, and state would create
   a confusing impedance mismatch.

3. **No ecosystem leverage**: Unlike WebDriver where BiDi compliance enables
   cross-browser automation, there is no existing ecosystem of BiDi-compatible
   agent tools that would benefit from strict compliance.

---

## 6. Proposed Protocol Design

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

All messages follow a minimal framing inspired by JSON-RPC and BiDi:

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

Modeled after WebDriver BiDi's `session.subscribe` but simplified:

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

| Dimension | Current LangGraph | WebDriver BiDi | A2A | **Proposed** |
|-----------|------------------|----------------|-----|--------------|
| **Transport** | SSE / in-process | WebSocket | HTTP + SSE | WebSocket + SSE + in-process |
| **Direction** | Unidirectional | Bidirectional | Unidirectional (SSE) + HTTP | Bidirectional (WS) / Uni + HTTP (SSE) |
| **Filtering** | Client-side | Server-side (subscription) | None (per-task streams) | Server-side (subscription) |
| **Namespace model** | Flat array (checkpoint_ns) | Context tree | Flat (task ID) | Hierarchical namespace tree |
| **Scoping** | All-or-nothing (subgraphs: true/false) | Per-context + per-module | Per-task | Per-namespace + per-channel + depth |
| **Lifecycle** | Implicit (stream end) | Session lifecycle | Task state machine | Subagent lifecycle events |
| **Backpressure** | None | None | None | Configurable per-connection |
| **Reconnection** | None | Session restore | tasks/resubscribe | Event buffer + reconnect |
| **Discovery** | None | browsingContext.getTree | Agent Cards | agent.getTree |
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

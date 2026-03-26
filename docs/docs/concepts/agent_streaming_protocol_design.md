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
- [7. Multimodal Streaming](#7-multimodal-streaming)
- [8. Comparison to Other Streaming Protocols](#8-comparison-to-other-streaming-protocols)
  - [8.5 Codex Multi-Agent ("Collab") Architecture](#85-codex-multi-agent-collab-architecture)
- [9. Migration Path](#9-migration-path)

---

## 1. Problem Statement

LangGraph agents can orchestrate complex hierarchies of subagents. In production
scenarios, a single root agent may spawn **hundreds of concurrent subagents**,
each producing streaming output (LLM tokens, tool calls, state updates, custom
events). The frontend needs to consume this data in real time without performance
degradation.

Additionally, agents are becoming **multimodal**. In a single run, subagent A
may stream text tokens, subagent B may produce a real-time audio stream
(e.g., voice synthesis, audio analysis), and subagent C may generate video
frames or image artifacts. The protocol must handle these heterogeneous
modalities — each with fundamentally different data formats, bandwidth
requirements, and latency constraints — within the same hierarchical
streaming architecture.

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
| **Specification style** | CDDL formal grammar, 300+ pages | CDDL formal grammar, focused spec | With JS, Python, and Java implementations, CDDL provides a single source of truth for code generation across all three runtimes — same benefit BiDi gets across browser vendors. Spec scope is much smaller (~5 channels, ~4 commands vs BiDi's 9+ modules, 50+ commands). |
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
concurrently. The canonical definitions are in CDDL (section 6.3); TypeScript
interfaces shown here are illustrative:

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

### 6.3 Schema Definition (CDDL)

Following BiDi, the protocol is formally defined using CDDL (Concise Data
Definition Language, [RFC 8610](https://www.rfc-editor.org/rfc/rfc8610)).
With LangGraph implementations in JavaScript, Python, and Java, CDDL serves
as the single source of truth from which language-specific types are generated:

```
┌──────────────┐
│  protocol.cddl │   ← Single source of truth
└──────┬───────┘
       │
  ┌────┼────────────────┐
  │    │                 │
  ▼    ▼                 ▼
 TS   Python            Java
types  dataclasses/      records/
       TypedDicts        classes
```

The CDDL definition covers the same three message types shown above, plus all
channel-specific payload shapes. Example:

```cddl
; --- Message framing (mirrors BiDi) ---

Command = {
  id: js-uint,
  method: text,
  params: {* text => any},
}

CommandResponse = {
  type: "success",
  id: js-uint,
  result: ResultData,
}

ErrorResponse = {
  type: "error",
  id: js-uint,
  error: ErrorCode,
  message: text,
  ? stacktrace: text,
}

Event = {
  type: "event",
  method: text,
  params: EventParams,
}

EventParams = {
  namespace: [* text],           ; Subagent hierarchy path
  timestamp: uint,               ; Server timestamp (ms)
  data: any,                     ; Channel-specific payload
}

; --- Commands ---

CommandData = (
  SubscriptionCommand //
  FlowCommand //
  AgentCommand
)

; --- Subscription module (mirrors BiDi session.subscribe) ---

SubscriptionCommand = (
  subscription.subscribe //
  subscription.unsubscribe //
  subscription.reconnect
)

subscription.subscribe = {
  method: "subscription.subscribe",
  params: SubscribeParams,
}

SubscribeParams = {
  channels: [+ Channel],
  ? namespaces: [* [* text]],    ; Prefix-match these namespace paths
  ? depth: uint,                 ; Max depth below prefix
}

Channel = "values" / "updates" / "messages" / "tools" /
          "custom" / "lifecycle" / "debug" / "checkpoints" / "media"

; --- Agent module (mirrors BiDi browsingContext) ---

agent.getTree = {
  method: "agent.getTree",
  params: { runId: text },
}

AgentTreeNode = {
  namespace: [* text],
  status: AgentStatus,
  graphName: text,
  children: [* AgentTreeNode],
}

AgentStatus = "spawned" / "running" / "completed" / "failed" / "interrupted"

; --- Shared ---

js-uint = 0..9007199254740991
ErrorCode = "invalid_argument" / "unknown_command" / "unknown_error" /
            "no_such_run" / "no_such_subscription" / "no_such_namespace"
ResultData = any
```

This is intentionally compact compared to BiDi's full grammar — the agent
streaming domain has far fewer primitives. The CDDL file is the contract;
TypeScript interfaces, Python dataclasses, and Java records are generated
artifacts.

### 6.4 Namespace Model

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

### 6.5 Subscription Management

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

**Event replay on new subscriptions**: When a client subscribes to a namespace
mid-run, the server replays buffered events for that namespace so the client
sees the full history — not just events from the subscription point forward.
This is modeled after Codex's `ThreadEventStore` pattern, where switching to a
child agent replays all stored events to reconstruct the conversation. The
subscribe response indicates how many events were replayed:

```typescript
{
  id: 1,
  result: {
    subscriptionId: "sub_abc123",
    replayedEvents: 47              // Events replayed from buffer
  }
}
```

### 6.6 Event Channels (Modules)

Channels map to the existing `StreamMode` values plus new lifecycle events:

| Channel | Description | Payload Shape |
|---------|-------------|---------------|
| `values` | Full state after each step | `{ values: Record<string, unknown> }` |
| `updates` | Per-node state deltas | `{ node: string, updates: Record<string, unknown> }` |
| `messages` | LLM token streaming | `{ message: BaseMessage, metadata: Record<string, unknown> }` |
| `tools` | Tool lifecycle events | `{ event: "start"\|"end"\|"error", name: string, ... }` |
| `custom` | User-defined payloads | `unknown` |
| `lifecycle` | **New**: Subagent lifecycle | `{ event: "spawned"\|"running"\|"completed"\|"failed"\|"interrupted", agentId: string }` |
| `media` | **New**: Binary media streams | `media.streamStart` / `media.streamEnd` / `media.artifact` events + binary frames (see [section 7](#7-multimodal-streaming)) |
| `debug` | Verbose execution traces | `Record<string, unknown>` |
| `checkpoints` | Checkpoint metadata | `{ values, next, config, metadata, ... }` |

The `lifecycle` channel is new and inspired by A2A's task lifecycle. It enables
the frontend to:
- Know when new subagents spawn (dynamically subscribe to them)
- Track which subagents are active vs. completed
- Display a real-time hierarchy view of the agent tree

### 6.7 Backpressure and Flow Control

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

### 6.8 Reconnection and Resubscription

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

**Snapshot + drain**: During reconnection (and during event replay on new
subscriptions), there is a race between replaying buffered events and new
events arriving. The server must: (1) take a snapshot of the buffer,
(2) replay the snapshot, (3) drain any events that arrived during replay
before switching to live delivery. This prevents the client from missing
events that arrived between the snapshot and the live stream activation.
This pattern is borrowed from Codex's `drain_active_thread_events()` which
handles the same race condition when switching thread views.

### 6.9 Hierarchy Discovery

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

## 7. Multimodal Streaming

### 7.1 The Problem

Today's streaming protocols — including LangGraph's current implementation —
treat all output as JSON-serializable text. This assumption breaks when agents
produce binary media:

| Modality | Data Format | Bandwidth | Latency Requirement |
|----------|-------------|-----------|---------------------|
| Text (LLM tokens) | UTF-8 / JSON | ~1-10 KB/s | Tolerant (~100ms chunks) |
| Audio (speech synthesis, analysis) | PCM / Opus / MP3 binary | ~32-128 KB/s | Strict (~20-50ms for real-time) |
| Video (screen capture, generation) | H.264 / VP8 / raw frames | ~500 KB-5 MB/s | Strict (~33ms for 30fps) |
| Images (generated artifacts) | PNG / JPEG / WebP binary | ~50-500 KB per image | Tolerant (whole-file delivery) |

A protocol that forces audio through `JSON.stringify(base64Encode(pcmBuffer))`
adds ~33% size overhead from Base64, plus JSON serialization/parsing cost on
every frame. At 128 KB/s of raw audio, that becomes ~170 KB/s on the wire with
Base64 — and the CPU cost of encoding/decoding dwarfs the actual audio
processing.

### 7.2 Mixed-Mode Framing

WebSocket natively supports two frame types: **text** (opcode 0x1, UTF-8) and
**binary** (opcode 0x2, raw bytes). Our protocol uses both:

```
┌─────────────────────────────────────────────────────────────┐
│                    WebSocket Connection                      │
├─────────────────────────────┬───────────────────────────────┤
│     Text Frames (JSON)      │      Binary Frames            │
│                             │                               │
│  Commands, responses,       │  Audio chunks, video frames,  │
│  text/tool/lifecycle events │  image data, file artifacts   │
└─────────────────────────────┴───────────────────────────────┘
```

**Binary frame header** (fixed 16-byte prefix on every binary frame):

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
├─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┼─┤
│  Stream ID (32-bit)         │  Sequence (32-bit)              │
├─────────────────────────────┼───────────────────────────────  │
│  Timestamp µs (32-bit)      │  Payload length (32-bit)        │
├─────────────────────────────┼─────────────────────────────────┤
│  Payload (variable length)                                    │
└───────────────────────────────────────────────────────────────┘
```

- **Stream ID**: Maps to a media stream opened via a JSON command (see below).
  The client can correlate this to a namespace + modality.
- **Sequence**: Monotonically increasing per stream, enabling gap detection
  and reordering if needed.
- **Timestamp**: Microsecond offset from stream start, enabling synchronized
  playback across streams.
- **Payload**: Raw media bytes (PCM samples, encoded video frames, image data).

This design avoids Base64 overhead entirely. A 20ms chunk of 24kHz 16-bit PCM
audio is 960 bytes of payload + 16 bytes of header = 976 bytes total, compared
to ~1,300 bytes with Base64+JSON wrapping.

### 7.3 Media Stream Lifecycle

Media streams are opened and closed via JSON commands on the text channel,
following BiDi's pattern of commands that set up stateful resources:

```typescript
// Server → Client: a subagent has started producing audio
{
  type: "event",
  method: "media.streamStart",
  params: {
    namespace: ["agent_b"],
    streamId: 42,
    mediaType: "audio",
    codec: "pcm_s16le",
    sampleRate: 24000,
    channels: 1,
    metadata: { voice: "alloy", language: "en-US" }
  }
}

// Binary frames with streamId=42 follow...

// Server → Client: audio stream completed
{
  type: "event",
  method: "media.streamEnd",
  params: {
    namespace: ["agent_b"],
    streamId: 42,
    reason: "completed",
    durationMs: 4500
  }
}
```

For video and images:

```typescript
// Video stream from a screen-capture subagent
{
  type: "event",
  method: "media.streamStart",
  params: {
    namespace: ["agent_c"],
    streamId: 43,
    mediaType: "video",
    codec: "h264",
    width: 1280,
    height: 720,
    frameRate: 30
  }
}

// Single image artifact (non-streaming)
{
  type: "event",
  method: "media.artifact",
  params: {
    namespace: ["agent_d"],
    streamId: 44,
    mediaType: "image",
    mimeType: "image/png",
    width: 1024,
    height: 768,
    sizeBytes: 245760
  }
}
// Followed by binary frame(s) with streamId=44, then media.streamEnd
```

### 7.4 Subscription Model for Multimodal Streams

The subscription system extends naturally. Clients subscribe to media channels
the same way they subscribe to text channels:

```typescript
// Subscribe to audio from agent_b and text from agent_a
{
  id: 10,
  method: "subscription.subscribe",
  params: {
    channels: ["messages"],
    namespaces: [["agent_a"]]
  }
}
{
  id: 11,
  method: "subscription.subscribe",
  params: {
    channels: ["media"],
    namespaces: [["agent_b"]],
    mediaTypes: ["audio"]          // Only audio, not video
  }
}
```

A client that only wants text never receives binary frames. A monitoring
dashboard subscribes to `lifecycle` globally to see all agents, then
selectively subscribes to `media` for the specific agent the user clicks on.

### 7.5 SSE Transport Fallback for Media

SSE cannot carry binary frames. When the transport is SSE (no WebSocket), media
data falls back to one of:

| Strategy | Mechanism | Trade-off |
|----------|-----------|-----------|
| **Base64 inline** | Media chunks sent as Base64-encoded JSON events | +33% overhead, works everywhere |
| **Parallel binary channel** | Server provides a URL per media stream; client opens a `fetch()` stream for binary data | Zero encoding overhead, requires CORS and separate connection management |
| **Upgrade hint** | Server sends a `transport.upgradeAvailable` event suggesting WebSocket | Client can decide to upgrade for media-heavy workloads |

The in-process transport passes `ArrayBuffer` / `Buffer` objects directly with
no serialization.

### 7.6 Synchronized Multimodal Playback

When subagent B produces audio and subagent A produces the corresponding text
transcript, the client needs to synchronize them. The protocol supports this
via **correlation IDs** in event metadata:

```typescript
// Text event with correlation to audio stream
{
  type: "event",
  method: "messages.delta",
  params: {
    namespace: ["agent_b"],
    timestamp: 1711454400000,
    data: {
      message: { content: "Hello, how can I help?", type: "ai" },
      metadata: {
        correlatedStreamId: 42,       // Links to audio stream 42
        audioOffsetMs: 0,             // This text corresponds to audio at 0ms
        audioEndMs: 2100              // Through 2100ms
      }
    }
  }
}
```

This enables the frontend to highlight text as audio plays, or to seek audio
when the user clicks a text segment.

### 7.7 CDDL Extensions for Multimodal

```cddl
; --- Media module ---

media.streamStart = {
  type: "event",
  method: "media.streamStart",
  params: MediaStreamStartParams,
}

MediaStreamStartParams = {
  namespace: [* text],
  streamId: js-uint,
  mediaType: MediaType,
  codec: text,
  ? sampleRate: uint,             ; Audio: samples per second
  ? channels: uint,               ; Audio: channel count
  ? width: uint,                  ; Video/image: pixel width
  ? height: uint,                 ; Video/image: pixel height
  ? frameRate: uint,              ; Video: frames per second
  ? mimeType: text,               ; Image: MIME type
  ? sizeBytes: uint,              ; Image: total size (for progress)
  ? metadata: {* text => any},    ; Codec-specific metadata
}

MediaType = "audio" / "video" / "image"

media.streamEnd = {
  type: "event",
  method: "media.streamEnd",
  params: MediaStreamEndParams,
}

MediaStreamEndParams = {
  namespace: [* text],
  streamId: js-uint,
  reason: "completed" / "failed" / "cancelled",
  ? durationMs: uint,
  ? error: text,
}

media.artifact = {
  type: "event",
  method: "media.artifact",
  params: MediaStreamStartParams,  ; Same shape, used for non-streaming media
}

; Binary frame header (not JSON — fixed 16 bytes before payload)
; BinaryFrameHeader = [
;   streamId: uint32,
;   sequence: uint32,
;   timestampMicros: uint32,
;   payloadLength: uint32,
; ]

; Extended subscription params
SubscribeParams //= {
  channels: [+ Channel],
  ? namespaces: [* [* text]],
  ? depth: uint,
  ? mediaTypes: [+ MediaType],    ; Filter media by type
}

Channel /= "media"               ; Add media to channel choices
```

---

## 8. Comparison to Other Streaming Protocols

### 8.1 Vercel AI SDK Stream Protocol

The [Vercel AI SDK](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
defines two streaming protocols: a plain-text stream and a "data stream"
using SSE. The data stream protocol sends typed JSON events
(`text-delta`, `tool-input-start`, `tool-output-available`, `file`, etc.)
over SSE.

| Dimension | Vercel AI SDK | Agent Streaming Protocol |
|-----------|---------------|--------------------------|
| **Scope** | Single LLM call → single frontend component | Hierarchical multi-agent system → multiple frontend consumers |
| **Architecture** | Flat event stream, one message at a time | Namespace tree with subscription-based filtering |
| **Multi-agent** | No concept of subagents or concurrent tasks | First-class namespace hierarchy, lifecycle tracking |
| **Filtering** | None — client receives all events | Server-side subscription filtering by namespace + channel + depth |
| **Direction** | Unidirectional (SSE only) | Bidirectional (WebSocket primary, SSE fallback) |
| **Media** | `file` part with URL reference; no binary streaming | Native binary frames for audio/video with zero Base64 overhead |
| **Backpressure** | None | Configurable per-connection flow control |
| **Reconnection** | Client-side retry via `chatResume` | Protocol-level reconnect with event buffer replay |
| **Schema** | Implicit TypeScript types, no formal grammar | CDDL formal grammar → codegen for JS, Python, Java |
| **Transport** | SSE only | WebSocket + SSE + in-process |

**Why our protocol is better for multi-agent streaming**:

The Vercel AI SDK protocol is designed for a specific, simpler problem: one LLM
call producing one response stream consumed by one React hook (`useChat`). It
has no concept of multiple concurrent agents, no way to subscribe to a subset
of a complex execution, and no support for binary media streaming. When you
have 200 subagents running concurrently and the user wants to watch 3 of them,
the Vercel protocol would require 200 separate SSE connections (one per agent)
or a single connection flooding the client with all events. Our protocol handles
this with a single connection plus server-side subscription filtering.

The Vercel protocol also lacks a formal schema. Its event types (`text-delta`,
`tool-input-start`, etc.) are defined implicitly through TypeScript code and
documentation examples. With implementations in JS, Python, and Java, we need
a single canonical grammar (CDDL) from which all language bindings are
generated — not three manually-synchronized type definitions.

### 8.2 Anthropic Messages Streaming

Anthropic's [Messages API streaming](https://docs.anthropic.com/claude/reference/streaming)
uses SSE with typed events (`message_start`, `content_block_start`,
`content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`).

| Dimension | Anthropic Streaming | Agent Streaming Protocol |
|-----------|---------------------|--------------------------|
| **Scope** | Single API call | Multi-agent hierarchy |
| **Architecture** | Linear event sequence (start → deltas → stop) | Tree-structured events with concurrent branches |
| **Multi-agent** | None | First-class |
| **Content types** | `text`, `tool_use`, `thinking` blocks | Text, tools, state, lifecycle, custom, media (audio/video/image) |
| **Binary media** | Not supported | Native binary frames |
| **Filtering** | None | Subscription-based |
| **Direction** | Unidirectional | Bidirectional |

**Why our protocol is better**: Anthropic's protocol is an LLM API protocol,
not an agent protocol. It models a single model call with a linear sequence of
content blocks. There is no concept of nested execution, concurrent tasks, or
selective observation. It is the right design for "stream one model response"
and the wrong design for "stream a tree of 200 concurrent agent executions."

### 8.3 OpenAI Realtime API

OpenAI's [Realtime API](https://platform.openai.com/docs/guides/realtime-websocket)
uses WebSocket with JSON events for text and Base64-encoded audio within JSON
payloads. It also supports WebRTC for browser-side audio.

| Dimension | OpenAI Realtime | Agent Streaming Protocol |
|-----------|-----------------|--------------------------|
| **Scope** | Single real-time conversation session | Multi-agent hierarchy |
| **Architecture** | Session with conversation items | Namespace tree with subscription filtering |
| **Multi-agent** | None | First-class |
| **Audio format** | Base64 in JSON (WebSocket) or WebRTC media tracks | Native binary frames — zero Base64 overhead |
| **Video** | Not supported (input only via images) | Native binary video streaming |
| **Filtering** | None — session receives all events | Subscription-based |
| **Session limits** | 60-minute maximum | No inherent session limit |
| **Binary efficiency** | Base64 adds ~33% overhead on every audio chunk | Raw binary frames with 16-byte header |

**Why our protocol is better**: OpenAI's Realtime API is built for one
conversation with one model. Its audio handling (Base64 in JSON) adds
unnecessary overhead that becomes significant at scale — 200 concurrent
audio-producing subagents would generate ~33% more wire traffic than necessary.
Our protocol uses native WebSocket binary frames with a minimal fixed header,
and the subscription model means a client only receives audio from the
subagents it's actively listening to.

### 8.4 A2A Protocol (Revisited for Multimodal)

A2A supports multimodal content through its `Part` abstraction (text, file,
structured data), but:

| Dimension | A2A | Agent Streaming Protocol |
|-----------|-----|--------------------------|
| **Media delivery** | File `Part` with inline Base64 or URI reference | Native binary frames with stream lifecycle |
| **Streaming media** | Not supported — files are delivered as complete artifacts | Real-time binary streaming with sequence numbers and timestamps |
| **Audio sync** | No concept | Correlation IDs linking text ↔ audio timestamps |
| **Modality filtering** | None | `mediaTypes` filter in subscription |
| **Concurrent streams** | One task = one stream | Multiple named binary streams per connection, scoped to namespace |

**Why our protocol is better for multimodal**: A2A treats media as artifacts —
complete files delivered after the fact. It has no concept of real-time audio
streaming, frame-by-frame video delivery, or synchronized multimodal playback.
An agent producing live speech cannot stream audio through A2A in real time; it
must complete the audio, package it as a file Part, and deliver it as a finished
artifact.

### 8.5 Codex Multi-Agent ("Collab") Architecture

OpenAI's [Codex CLI](https://github.com/openai/codex) implements a
multi-agent system (codenamed "Collab") where a parent agent spawns child
agents as independent threads, each with its own LLM context, tool access,
and sandbox. The system is implemented in Rust and exposes five tool
functions to the LLM: `spawn_agent`, `send_input`, `wait`, `resume_agent`,
and `close_agent`.

#### Event Streaming Architecture

Codex's TUI rendering pipeline for multi-agent events reveals several
design patterns directly relevant to our protocol:

```
CodexThread (parent)  ──┐
CodexThread (child 1) ──┤──→ ThreadEventChannel ──→ ThreadEventStore ──→ ┐
CodexThread (child 2) ──┘                                                │
                                                                         ▼
                                                              tokio::select! {
                                                                app_event_rx,      // primary thread
                                                                active_thread_rx,  // viewed thread
                                                                tui_events,        // keyboard/mouse
                                                                thread_created_rx, // new child spawns
                                                              }
                                                                         │
                                                                         ▼
                                                                    ChatWidget
```

Each child thread gets a `ThreadEventChannel` with three components:

| Component | Purpose |
|-----------|---------|
| `sender` (mpsc) | Sends live events to the active view channel |
| `receiver` (mpsc) | Taken when thread becomes the active view |
| `store` (shared) | Persists ALL events regardless of active view (for replay) |

The `store.active` flag controls whether events are forwarded to the mpsc
channel or only buffered. When a user switches to viewing a different
agent, the store replays all historical events to reconstruct the
conversation.

#### Useful Patterns for Our Protocol

**1. Buffered event stores with replay** — Codex stores all events for every
thread, not just the active one. When the user switches to a child agent's
view, the full event history is replayed. This is directly applicable to our
protocol: a client that subscribes to a new namespace mid-run should receive
a replay of that namespace's events (analogous to our `subscription.reconnect`
with event buffer, but applied to first-time subscriptions too).

**2. Active/inactive multiplexing** — Rather than delivering all threads'
events simultaneously, Codex only forwards events from the "active" thread
through the mpsc channel. Non-active threads still capture events in the
store. This is the same optimization as our subscription-based filtering:
the server only serializes and sends events for subscribed namespaces, but
internally all events are still captured (for later replay, reconnection,
or subscription changes).

**3. Begin/End event pairs** — Codex emits paired events
(`CollabAgentSpawnBegin` / `CollabAgentSpawnEnd`, `CollabWaitingBegin` /
`CollabWaitingEnd`, etc.). The `Begin` events are typically no-ops in
rendering; only `End` events carry the final status. Our protocol's
`lifecycle` channel should adopt this pattern: emit `lifecycle.begin`
when an operation starts (for progress indicators) and `lifecycle.end`
with the final status.

**4. Completion watchers** — when a child agent is spawned, a background
task (`completion_watcher`) subscribes to the child's status via a
`tokio::watch` channel. When the child reaches a terminal state, the
parent is notified by injecting a message into its conversation context.
Our `lifecycle` channel serves the same purpose at the protocol level:
clients (and parent agents) receive `lifecycle.completed` events without
polling.

**5. Thread switching with snapshot + drain** — Codex's thread-switch
algorithm takes a snapshot, replays it, then drains any events that arrived
during replay. This prevents a race condition where events are missed
between snapshot and activation. Our reconnection protocol (section 6.8)
should account for this same race: after replaying missed events, drain
any new events that arrived during replay before switching to live
streaming.

#### Limitations of the Codex Approach

| Limitation | Our Protocol's Solution |
|------------|-------------------------|
| **Single-viewer** — only one thread can be "active" at a time in the TUI | Subscription-based: client can subscribe to N namespaces simultaneously |
| **Local only** — `ThreadEventChannel` is an in-process mpsc channel; no network protocol | Transport-agnostic: WebSocket + SSE + in-process |
| **No selective event types** — viewer gets all event types from the active thread | Channel-based filtering: subscribe to `messages` from one namespace and `tools` from another |
| **No binary media** — all events are JSON protocol messages | Mixed-mode framing with native binary frames |
| **No backpressure** — mpsc channel has fixed capacity; no flow control negotiation | Configurable backpressure strategies per connection |
| **No reconnection** — in-process only; no concept of disconnected clients | Event buffer + `subscription.reconnect` |

The Codex architecture validates our core design intuition — the
event-per-thread-with-store-and-active-view pattern is structurally the same
as our subscription-per-namespace-with-buffer-and-filtering pattern, but our
protocol generalizes it for network transport, multiple simultaneous views,
channel-level filtering, binary media, and cross-language implementations.

### 8.6 Summary: Protocol Positioning

```
                    Multi-agent           Single-agent
                    ┌─────────────────────┬──────────────────────┐
                    │                     │                      │
  Real-time         │  ★ Agent Streaming  │  OpenAI Realtime     │
  multimodal        │    Protocol         │                      │
  (audio/video)     │                     │                      │
                    ├─────────────────────┼──────────────────────┤
                    │                     │                      │
  Text/tool         │  ★ Agent Streaming  │  Vercel AI SDK       │
  streaming         │    Protocol         │  Anthropic Messages  │
  (networked)       │                     │                      │
                    ├─────────────────────┼──────────────────────┤
                    │                     │                      │
  Text/tool         │  Codex Collab       │                      │
  streaming         │  (in-process only)  │                      │
  (local)           │                     │                      │
                    ├─────────────────────┼──────────────────────┤
                    │                     │                      │
  Inter-agent       │  A2A                │                      │
  (opaque)          │                     │                      │
                    │                     │                      │
                    └─────────────────────┴──────────────────────┘
```

Our protocol occupies the upper-left quadrant: **multi-agent, real-time,
multimodal, networked**. Codex's Collab system validates the multi-agent
event streaming pattern but is constrained to in-process mpsc channels with
single-viewer semantics. The Vercel AI SDK, Anthropic, and OpenAI protocols
are single-agent solutions. A2A is multi-agent but opaque and non-streaming
for media. Our BiDi-modeled protocol generalizes the Codex pattern for
network transport, multiple simultaneous views, channel-level filtering,
binary media, and cross-language implementations.

---

## 9. Migration Path

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

### Phase 5: Multimodal Streaming

Add the `media` channel with binary frame support. This requires the WebSocket
transport from Phase 2.

**Changes required**:
- Binary frame header serialization/deserialization (16-byte fixed prefix)
- `media.streamStart` / `media.streamEnd` / `media.artifact` event handling
- Stream ID registry mapping stream IDs to namespace + media metadata
- `mediaTypes` filter in subscription params
- SSE fallback strategy (Base64 inline or parallel binary channel)
- Correlation ID support for synchronized multimodal playback
- CDDL schema extensions for media types

---

## Appendix A: Protocol Comparison Matrix

| Dimension | Current LangGraph | WebDriver BiDi | A2A | Vercel AI SDK | Anthropic | OpenAI Realtime | Codex Collab | **Proposed (BiDi-modeled)** |
|-----------|------------------|----------------|-----|---------------|-----------|-----------------|--------------|---------------------------|
| **Scope** | Multi-agent | Browser automation | Inter-agent | Single LLM call | Single LLM call | Single session | Multi-agent (local) | Multi-agent (networked) |
| **Transport** | SSE / in-process | WebSocket | HTTP + SSE | SSE | SSE | WebSocket / WebRTC | In-process mpsc | WebSocket + SSE + in-process |
| **Direction** | Unidirectional | Bidirectional | Uni (SSE) + HTTP | Unidirectional | Unidirectional | Bidirectional | Bidirectional (in-process) | Bidirectional |
| **Filtering** | Client-side | Server-side (subscription) | None | None | None | None | Active thread only (single-viewer) | Server-side (subscription, multi-viewer) |
| **Namespace model** | Flat array | Context tree | Flat (task ID) | None | None | None | Flat thread IDs | Hierarchical namespace tree |
| **Event buffering** | None | N/A | None | None | None | None | Per-thread store + replay | Per-namespace buffer + replay |
| **Multimodal** | Text only | N/A | File Parts (artifacts) | `file` URL ref | Text + tool blocks | Base64 audio in JSON | Text only | Native binary frames |
| **Binary streaming** | No | No | No | No | No | Base64 (+33% overhead) | No | Yes (16-byte header) |
| **Backpressure** | None | None | None | None | None | None | Fixed mpsc capacity | Configurable per-connection |
| **Reconnection** | None | Session restore | tasks/resubscribe | Client-side chatResume | None | None | Resume from rollout file | Event buffer + reconnect |
| **Schema** | TS types | CDDL | JSON Schema | Implicit TS | Implicit | OpenAPI | Rust types | CDDL → JS, Python, Java |

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

## Appendix C: Comparison to Other Transport Options

### Why Not Just Use GraphQL Subscriptions?

GraphQL subscriptions offer field-level filtering and are a viable transport
option. However, they add a query language layer that is unnecessary when the
event schema is well-defined and the filtering model is namespace + channel
based. The proposed protocol is simpler, has no query parsing overhead, and
maps directly to LangGraph's internal concepts. GraphQL also has no native
binary frame support — media would still require Base64 encoding or out-of-band
delivery.

### Why Not gRPC Streaming?

gRPC bidirectional streaming would work well technically and handles binary data
natively via protobuf. However, it limits browser compatibility (requires
gRPC-Web proxy), adds protobuf compilation steps, and conflicts with the
existing SSE-based ecosystem. The proposed protocol achieves similar
capabilities over standard WebSocket/HTTP with broader platform reach.

### Why Not WebRTC for Media?

WebRTC is excellent for peer-to-peer audio/video but adds significant
complexity (ICE negotiation, STUN/TURN servers, codec negotiation) that is
unnecessary in a client-server agent streaming scenario. Our binary frames over
WebSocket provide sufficient performance for server-generated media without the
peer-to-peer infrastructure overhead. For latency-critical voice applications
(sub-20ms), a future protocol extension could add WebRTC as an optional media
transport alongside WebSocket binary frames.

### Relationship to Model Context Protocol (MCP)

MCP connects agents to tools and data sources. It is complementary to this
protocol — MCP handles tool/resource access while the agent streaming protocol
handles real-time execution observability. They operate at different layers
and do not conflict.

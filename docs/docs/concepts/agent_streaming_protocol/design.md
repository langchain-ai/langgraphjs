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
- [8. Extended Protocol Modules](#8-extended-protocol-modules)
- [9. Enabling Scenarios](#9-enabling-scenarios)
- [10. Implementation Assessment](#10-implementation-assessment)
- [11. Comparison to Other Streaming Protocols](#11-comparison-to-other-streaming-protocols)
  - [11.5 Codex Multi-Agent ("Collab") Architecture](#115-codex-multi-agent-collab-architecture)

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
  server pushes events. Preferred for interactive frontends. A JS client
  library connects to the protocol endpoint, analogous to how Puppeteer
  connects to Chrome DevTools via the CDP WebSocket.
- **SSE + HTTP**: Server pushes events via SSE. Client manages subscriptions
  via HTTP POST to a control endpoint. Works in serverless/edge environments.
- **In-Process**: Direct programmatic API when the graph and consumer share
  a process. Zero serialization overhead. See section 6.1.1 below.

#### 6.1.1 In-Process Transport

The in-process transport is the primary interface for developers running
agents locally — in scripts, notebooks, CLI tools, test suites, and backend
services. The protocol concepts (subscriptions, channels, namespaces,
commands) map to a native API that feels like a natural evolution of the
current `graph.stream()`, not like a network client.

**Relationship to `graph.stream()`**:

Today, `graph.stream()` returns a flat async iterator that yields all events
matching the requested `streamMode`. The in-process transport wraps the same
execution with a `Session` object that exposes the full protocol surface:

```typescript
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { createSession } from "@langchain/langgraph/protocol";

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .compile();

// A session wraps a graph run with the full protocol API.
// It is the in-process equivalent of a WebSocket connection.
const session = createSession(graph, {
  input: { messages: [{ role: "user", content: "Research quantum computing" }] },
  config: { configurable: { thread_id: "thread_1" } },
});
```

**Subscriptions — same model, typed API**:

Instead of serializing `{ method: "subscription.subscribe", params: ... }`
as JSON, the in-process API exposes typed methods. Each returns a typed
async iterator — no JSON parsing, no string matching, no manual
deserialization:

```typescript
// Subscribe to LLM tokens from the root agent only
const messages = session.subscribe("messages");

// Subscribe to tool events from a specific subagent
const tools = session.subscribe("tools", {
  namespaces: [["agent_1", "researcher"]],
});

// Subscribe to sandbox output globally
const sandbox = session.subscribe("sandbox");

// Subscribe to lifecycle events to discover new subagents
const lifecycle = session.subscribe("lifecycle");

// Subscribe to multiple channels at once
const everything = session.subscribe(["messages", "tools", "lifecycle"]);
```

Each subscription returns a typed `AsyncIterable` that yields only
matching events — the same server-side filtering that happens on the
WebSocket path, but without serialization:

```typescript
// Consuming a subscription is a standard async for loop
for await (const event of messages) {
  // event is typed: { namespace: string[], timestamp: number, data: MessageDelta }
  console.log(`[${event.namespace.join("/")}] ${event.data.content}`);
}
```

**Multiple concurrent subscriptions**:

Unlike the current `graph.stream()` which yields one interleaved stream,
subscriptions are independent iterators. A frontend (or test, or script)
can consume them concurrently:

```typescript
const session = createSession(graph, { input, config });

// Three independent typed streams, consumed in parallel
const messages = session.subscribe("messages", { namespaces: [["agent_1"]] });
const tools = session.subscribe("tools", { namespaces: [["agent_1"]] });
const lifecycle = session.subscribe("lifecycle");

// Process them concurrently
await Promise.all([
  (async () => {
    for await (const event of messages) {
      renderToken(event.data);
    }
  })(),
  (async () => {
    for await (const event of tools) {
      renderToolCall(event.data);
    }
  })(),
  (async () => {
    for await (const event of lifecycle) {
      if (event.data.event === "spawned") {
        // Dynamically subscribe to the new subagent's messages
        const sub = session.subscribe("messages", {
          namespaces: [event.data.namespace],
        });
        consumeSubagentMessages(sub);
      }
    }
  })(),
]);
```

**Commands — same surface, method calls**:

Protocol commands map to methods on the session object:

```typescript
// Browse the subagent's sandbox filesystem
const files = await session.resource.list(["agent_1"], "/workspace/src");

// Read a file the agent wrote
const content = await session.resource.read(["agent_1"], "/workspace/src/api.ts");

// Send human-in-the-loop response
session.on("input.requested", async (event) => {
  await session.input.respond(event.interruptId, { approved: true });
});

// Inject user input mid-run
await session.input.inject(["agent_1"], {
  role: "user",
  content: "Also check the error handling",
});

// Get the current agent tree
const tree = await session.agent.getTree();

// Query cross-thread memory
const memories = await session.state.storeSearch(
  ["user_123", "memories"],
  { query: "quantum computing" }
);

// Set a cost budget
await session.usage.setBudget({ maxCostUsd: 5.0, action: "pause" });

// Fork from a checkpoint (time-travel)
const forked = await session.state.fork("checkpoint_abc", { input: newInput });
```

**Backward compatibility with `graph.stream()`**:

The current `graph.stream()` API continues to work unchanged. It is
equivalent to creating a session with a global subscription to the
requested stream modes:

```typescript
// These two are equivalent:

// Current API (unchanged)
for await (const chunk of await graph.stream(input, {
  streamMode: ["messages", "updates"],
  subgraphs: true,
})) {
  const [namespace, mode, data] = chunk;
}

// New API (session with global subscription)
const session = createSession(graph, { input });
for await (const event of session.subscribe(["messages", "updates"])) {
  const { namespace, channel, data } = event;
}
```

The difference is that `session` also gives you `subscribe()` with
namespace filtering, `resource.*`, `sandbox.*`, `input.*`, `state.*`,
`usage.*` — none of which exist on the current `graph.stream()` return
value.

**How it connects to the WebSocket/SSE path**:

The in-process `Session` and the network `ProtocolServer` share the
same `SubscriptionRegistry`, the same event buffer, and the same
command dispatch. The only difference is the transport:

```
                                 ┌─────────────────────┐
  graph.stream() ──────────────→ │                     │
                                 │  SubscriptionRegistry│
  createSession() ─────────────→ │  + EventBuffer      │ ← Same core
                                 │  + CommandDispatch   │
  WebSocket client ────────────→ │                     │
                                 │                     │
  SSE + HTTP client ───────────→ │                     │
                                 └─────────────────────┘
                                         │
                                 ┌───────┴───────┐
                                 │               │
                              In-process     Serialized
                              (typed objects) (JSON over
                                              WS/SSE)
```

This means any feature built for the protocol (a new module, a new
channel, a new command) automatically works in-process, over WebSocket,
and over SSE. There is no "network-only" or "local-only" capability —
the protocol is the API.

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
as the single source of truth from which language-specific types are generated.

The full draft CDDL schema is in
[`protocol.cddl`](./protocol.cddl) (covers
all 15 channels, all commands, all event types, and all result shapes).
The excerpt below shows the core framing and subscription module:

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

## 8. Extended Protocol Modules

The core protocol (sections 6-7) handles event streaming, subscriptions, and
media. But a next-generation agent streaming protocol must also handle the
**full surface area** of agent-frontend interaction. Deep Agents connect to
sandboxes, produce file artifacts, execute shell commands, read and write
state stores, require human input, and consume resources that cost money.
All of these should be observable and interactive through the same protocol
connection — not through separate REST APIs with different auth, different
error handling, and different transport semantics.

Following BiDi's modular architecture, each capability is a **module** with
its own commands and events, sharing the same connection, subscription model,
and CDDL schema.

### 8.1 Resource Module — File System Access

Deep Agents running in sandboxes (Modal, Daytona, E2B, local VFS) operate on
file systems that the frontend needs to observe and interact with. Today this
requires separate REST APIs or MCP tool calls. The protocol should make file
system access a first-class module.

**Commands** (client → server):

```typescript
// Browse a directory in a subagent's sandbox
{
  id: 20,
  method: "resource.list",
  params: {
    namespace: ["agent_1"],          // Which subagent's sandbox
    path: "/workspace/src",
    depth: 2,                        // Recurse 2 levels
    includeMetadata: true            // Size, modified time, permissions
  }
}

// Read a file from a subagent's sandbox
{
  id: 21,
  method: "resource.read",
  params: {
    namespace: ["agent_1"],
    path: "/workspace/src/index.ts",
    encoding: "utf-8",              // Or "binary" for raw bytes
    range: { startLine: 1, endLine: 50 }  // Optional partial read
  }
}

// Write a file (human-in-the-loop: user edits a file the agent wrote)
{
  id: 22,
  method: "resource.write",
  params: {
    namespace: ["agent_1"],
    path: "/workspace/src/config.ts",
    content: "export const API_KEY = '...';\n",
    encoding: "utf-8"
  }
}

// Download a binary file (agent-generated artifact)
{
  id: 23,
  method: "resource.download",
  params: {
    namespace: ["agent_2"],
    path: "/workspace/output/report.pdf"
  }
}
// Response provides a streamId; binary frames follow with the file data
```

**Events** (server → client):

```typescript
// File system change notification (agent wrote/deleted/moved a file)
{
  type: "event",
  method: "resource.changed",
  params: {
    namespace: ["agent_1"],
    timestamp: 1711454400000,
    data: {
      changes: [
        { type: "created", path: "/workspace/src/new-module.ts", sizeBytes: 2340 },
        { type: "modified", path: "/workspace/src/index.ts", sizeBytes: 5120 },
        { type: "deleted", path: "/workspace/src/old-module.ts" }
      ]
    }
  }
}
```

**Subscription**: `channels: ["resource"]` on a namespace. The client receives
file change notifications as the agent works. Combined with `messages` and
`tools`, this gives a complete picture: the agent decided to create a file
(visible in `messages`), called a tool to write it (visible in `tools`), and
the file appeared on disk (visible in `resource`).

### 8.2 Sandbox Module — Shell Output Streaming

Agents executing shell commands in sandboxed environments (Modal, Daytona,
E2B, local VFS) produce stdout/stderr streams that frontends need to display
in real time. Today, command output is captured as a single tool result string
after execution completes. The sandbox module streams it live.

**Events**:

```typescript
// Shell command started in sandbox
{
  type: "event",
  method: "sandbox.started",
  params: {
    namespace: ["agent_1"],
    timestamp: 1711454400000,
    data: {
      terminalId: "term_1",
      command: "npm run build",
      cwd: "/workspace",
      env: { NODE_ENV: "production" }  // Sanitized, no secrets
    }
  }
}

// Streaming stdout/stderr chunks
{
  type: "event",
  method: "sandbox.output",
  params: {
    namespace: ["agent_1"],
    timestamp: 1711454400050,
    data: {
      terminalId: "term_1",
      stream: "stdout",               // or "stderr"
      text: "Building project...\n"
    }
  }
}

// Command completed
{
  type: "event",
  method: "sandbox.exited",
  params: {
    namespace: ["agent_1"],
    timestamp: 1711454405000,
    data: {
      terminalId: "term_1",
      exitCode: 0,
      durationMs: 5000
    }
  }
}
```

**Commands** (client → server):

```typescript
// Send input to a running command (e.g., answering a prompt)
{
  id: 30,
  method: "sandbox.input",
  params: {
    namespace: ["agent_1"],
    terminalId: "term_1",
    text: "y\n"
  }
}

// Kill a running command
{
  id: 31,
  method: "sandbox.kill",
  params: {
    namespace: ["agent_1"],
    terminalId: "term_1",
    signal: "SIGTERM"
  }
}
```

### 8.3 Input Module — Human-in-the-Loop

LangGraph has `interrupt()` and `Command({ resume })` for human-in-the-loop.
Today this requires a separate API call to resume the thread. The protocol
should handle the full HITL lifecycle in-band.

**Events** (server → client):

```typescript
// Agent is requesting human input
{
  type: "event",
  method: "input.requested",
  params: {
    namespace: ["agent_1", "researcher"],
    timestamp: 1711454400000,
    data: {
      interruptId: "int_abc123",
      type: "approval",                // or "text", "choice", "form"
      prompt: "Agent wants to delete 47 files. Approve?",
      schema: {                        // JSON Schema for structured input
        type: "object",
        properties: {
          approved: { type: "boolean" },
          reason: { type: "string" }
        },
        required: ["approved"]
      },
      timeout: 300000                  // Auto-reject after 5 minutes
    }
  }
}
```

**Commands** (client → server):

```typescript
// Respond to an interrupt
{
  id: 40,
  method: "input.respond",
  params: {
    namespace: ["agent_1", "researcher"],
    interruptId: "int_abc123",
    response: { approved: true, reason: "Looks correct" }
  }
}

// Inject unsolicited input (user types while agent is running)
{
  id: 41,
  method: "input.inject",
  params: {
    namespace: ["agent_1"],
    message: { role: "user", content: "Actually, also check the tests" }
  }
}
```

This replaces the pattern of making a separate `POST /threads/:id/runs` call
with a `Command({ resume })` — the interaction happens on the same connection
with the same subscription context.

### 8.4 State Module — Store and Checkpoint Access

LangGraph's `BaseStore` (cross-thread KV with namespaces and vector search)
and checkpointer (per-thread state snapshots) are currently only accessible
via REST APIs. The protocol should expose them as observable, streamable
resources.

**Commands**:

```typescript
// Read current graph state for a namespace
{
  id: 50,
  method: "state.get",
  params: {
    namespace: ["agent_1"],
    keys: ["messages", "plan", "progress"]  // Specific keys, or omit for all
  }
}

// Query the cross-thread store
{
  id: 51,
  method: "state.storeSearch",
  params: {
    storeNamespace: ["user_123", "memories"],
    query: "previous research on quantum computing",
    limit: 5
  }
}

// Write to the store (user provides context)
{
  id: 52,
  method: "state.storePut",
  params: {
    storeNamespace: ["user_123", "preferences"],
    key: "output_format",
    value: { format: "markdown", verbosity: "concise" }
  }
}

// Browse checkpoint history (time-travel)
{
  id: 53,
  method: "state.listCheckpoints",
  params: {
    namespace: [],                    // Root agent
    limit: 20,
    before: "checkpoint_xyz"          // Pagination cursor
  }
}

// Fork from a historical checkpoint
{
  id: 54,
  method: "state.fork",
  params: {
    checkpointId: "checkpoint_abc",
    input: { messages: [{ role: "user", content: "Try a different approach" }] }
  }
}
```

**Events**:

```typescript
// State mutation notification (agent's graph state changed)
{
  type: "event",
  method: "state.updated",
  params: {
    namespace: ["agent_1"],
    timestamp: 1711454400000,
    data: {
      keys: ["plan", "progress"],     // Which keys changed
      checkpoint: "checkpoint_xyz"     // Corresponding checkpoint
    }
  }
}

// Store write notification (agent wrote to long-term memory)
{
  type: "event",
  method: "state.storeChanged",
  params: {
    namespace: ["agent_1"],
    timestamp: 1711454400000,
    data: {
      storeNamespace: ["user_123", "findings"],
      key: "quantum_research_v2",
      operation: "put"
    }
  }
}
```

### 8.5 Usage Module — Cost and Token Tracking

At scale (hundreds of subagents), cost visibility is critical. The protocol
should stream usage data so the frontend can display real-time cost dashboards,
set budgets, and halt runaway agents.

**Events**:

```typescript
// Per-LLM-call usage (emitted after each model invocation)
{
  type: "event",
  method: "usage.llmCall",
  params: {
    namespace: ["agent_1", "researcher"],
    timestamp: 1711454400000,
    data: {
      model: "gpt-4o",
      provider: "openai",
      inputTokens: 4200,
      outputTokens: 850,
      cachedTokens: 1200,
      costUsd: 0.0234,               // Computed cost
      latencyMs: 1340,
      requestId: "req_abc123"
    }
  }
}

// Aggregate usage snapshot (periodic summary)
{
  type: "event",
  method: "usage.summary",
  params: {
    namespace: [],                    // Root level = entire run
    timestamp: 1711454400000,
    data: {
      totalInputTokens: 142000,
      totalOutputTokens: 38000,
      totalCostUsd: 1.47,
      byModel: {
        "gpt-4o": { calls: 45, costUsd: 1.12 },
        "gpt-4o-mini": { calls: 230, costUsd: 0.35 }
      },
      byNamespace: {
        "agent_1": { calls: 12, costUsd: 0.34 },
        "agent_2": { calls: 28, costUsd: 0.89 }
      }
    }
  }
}
```

**Commands**:

```typescript
// Set a cost budget for the run (server enforces)
{
  id: 60,
  method: "usage.setBudget",
  params: {
    maxCostUsd: 5.00,
    action: "pause"                   // or "cancel" when budget exceeded
  }
}

// Set a per-subagent budget
{
  id: 61,
  method: "usage.setBudget",
  params: {
    namespace: ["agent_3"],
    maxCostUsd: 0.50,
    action: "cancel"
  }
}
```

### 8.6 Module Summary

| Module | Channel | Commands | Events | Purpose |
|--------|---------|----------|--------|---------|
| **subscription** | — | `subscribe`, `unsubscribe`, `reconnect` | — | Filtering and connection management |
| **agent** | `lifecycle` | `getTree` | `spawned`, `running`, `completed`, `failed` | Hierarchy discovery and lifecycle |
| **messages** | `messages` | — | LLM token deltas | Text streaming |
| **tools** | `tools` | — | Tool start/end/error | Tool observability |
| **media** | `media` | — | `streamStart`, `streamEnd`, `artifact` + binary frames | Audio/video/image |
| **resource** | `resource` | `list`, `read`, `write`, `download` | `changed` | File system access |
| **sandbox** | `sandbox` | `input`, `kill` | `started`, `output`, `exited` | Shell execution in sandboxed environments |
| **input** | `input` | `respond`, `inject` | `requested` | Human-in-the-loop |
| **state** | `state` | `get`, `storeSearch`, `storePut`, `listCheckpoints`, `fork` | `updated`, `storeChanged` | Graph state and store access |
| **usage** | `usage` | `setBudget` | `llmCall`, `summary` | Cost and token tracking |
| **flow** | — | `setCapacity` | — | Backpressure control |
| **values** | `values` | — | Full state snapshots | State after each step |
| **updates** | `updates` | — | Per-node deltas | Incremental state |
| **custom** | `custom` | — | User-defined payloads | Extension point |
| **debug** | `debug` | — | Verbose traces | Development |
| **checkpoints** | `checkpoints` | — | Checkpoint metadata | Persistence observability |

This gives **15 channels** and **~18 commands** — substantially more than the
initial ~5 channels / ~4 commands, but each module is independently subscribable.
A simple chat frontend subscribes to `messages` only. A full IDE-like agent
workspace subscribes to everything. The protocol supports both without
penalizing either.

---

## 9. Enabling Scenarios

The full protocol unlocks scenarios that no existing agent streaming system
supports. Each scenario below requires multiple modules working together over
a single protocol connection.

### 9.1 Agent IDE — Full Observability Workspace

A frontend that provides IDE-level visibility into agent execution:

```
┌─────────────────────────────────────────────────────────────┐
│  Agent IDE                                                   │
├──────────────┬──────────────┬───────────────┬───────────────┤
│  Agent Tree  │  Chat View   │  File Explorer│  Sandbox      │
│  (lifecycle) │  (messages,  │  (resource)   │  (sandbox)    │
│              │   tools)     │               │               │
│  ● root      │  User: ...   │  📁 src/      │  $ npm build  │
│  ├ agent_1 ● │  Agent: ...  │  ├ index.ts ★ │  > Building.. │
│  │ └ res. ✓  │  🔧 search() │  ├ utils.ts   │  > Done.      │
│  └ agent_2 ● │  Agent: ...  │  └ test.ts ★  │               │
│              │              │  ★ = changed   │  Exit: 0      │
├──────────────┴──────────────┴───────────────┼───────────────┤
│                                              │  Usage        │
│                                              │  (usage)      │
│                                              │               │
│                                              │  $1.47 total  │
│                                              │  142K in      │
│                                              │  38K out      │
└──────────────────────────────────────────────┴───────────────┘
```

**Protocol usage**: Single WebSocket connection. Agent tree panel subscribes to
`lifecycle` globally. Chat panel subscribes to `messages` + `tools` on the
selected namespace. File explorer subscribes to `resource` on the active
agent's namespace. Sandbox panel subscribes to `sandbox`. Usage panel subscribes
to `usage` globally. Clicking a different agent in the tree updates the
`messages` and `resource` subscriptions without disconnecting.

### 9.2 Deep Agent with Sandbox File Access

A deep agent running in a Modal/Daytona sandbox writes code, runs tests,
and iterates. The user can browse and edit files in the sandbox through
the same protocol connection:

1. Agent writes `/workspace/src/api.ts` → `resource.changed` event fires
2. User clicks the file in the UI → `resource.read` command fetches content
3. User edits a line → `resource.write` command updates the file
4. Agent runs `npm test` → `sandbox.started` + `sandbox.output` stream live
5. Tests fail → `sandbox.exited` with exitCode 1
6. Agent reads its own test output (internally), fixes the code
7. Agent writes updated file → `resource.changed` fires again
8. Agent runs tests again → pass

The entire interaction happens over one WebSocket connection with
appropriate channel subscriptions. No separate REST API calls, no
separate auth tokens, no separate error handling.

### 9.3 Human-Agent Collaboration with Sandbox

A user working alongside an agent that writes code in a sandbox:

1. Agent writes a first draft of `/workspace/src/api.ts` → `resource.changed`
2. User browses the file via `resource.read`, spots an issue
3. User edits the file directly via `resource.write`
4. User sends feedback via `input.inject`: "I fixed the auth header, now run tests"
5. Agent runs `npm test` → `sandbox.started` + `sandbox.output` streams live
6. Meanwhile, agent B is researching the API docs (subscribed via `lifecycle`)
7. Agent B completes → `lifecycle.completed` with findings
8. Agent A incorporates findings, writes updated code → `resource.changed`
9. Agent runs tests again → `sandbox.exited` with exitCode 0

The `resource`, `sandbox`, and `input` channels give the user full
read-write access to the agent's workspace, while `lifecycle` +
`messages` provide the narrative of what the agent is doing and why.

### 9.4 Cost-Controlled Parallel Research

A supervisor agent spawns 50 research subagents, each with a budget:

1. Frontend subscribes to `lifecycle` and `usage` globally
2. Supervisor spawns agents → 50 `lifecycle.spawned` events
3. Frontend sends `usage.setBudget` for each agent ($0.10 each)
4. `usage.llmCall` events stream in real-time; frontend shows a cost dashboard
5. Agent 17 hits its budget → server auto-pauses it; `lifecycle.interrupted`
6. User reviews agent 17's partial results via `state.get`, decides to increase budget
7. User sends `usage.setBudget` with higher limit → agent resumes
8. As agents complete, frontend unsubscribes from their namespaces (no wasted bandwidth)
9. `usage.summary` provides final cost breakdown by agent

### 9.5 Multimodal Agent with Live Audio + Generated Files

An agent that processes audio input, produces text analysis, and generates
output files:

1. Client subscribes to `media` (audio) + `messages` (text) + `resource`
   on namespace `["analyzer"]`
2. Audio stream flows in via binary frames (input from user's microphone)
3. Agent transcribes audio → `messages` events with correlation IDs linking
   to audio timestamps
4. Agent analyzes content → `messages` with intermediate reasoning
5. Agent generates a chart, writes it to sandbox → `resource.changed`
6. Client fetches chart via `resource.read` (binary encoding)
7. Audio + text + file changes are synchronized in the UI via correlation
   IDs and timestamps

### 9.6 Time-Travel Debugging

A developer debugging a failed agent run:

1. Frontend subscribes to `state` + `lifecycle` + `messages` + `tools`
2. Uses `state.listCheckpoints` to browse the checkpoint history
3. Identifies the checkpoint where things went wrong
4. Uses `state.fork` to create a new run from that checkpoint with
   different input
5. Subscribes to the forked run's namespace
6. Watches the forked execution alongside the original
7. Compares state and file outputs between original and forked runs

---

## 10. Implementation Assessment

This section maps the proposed protocol to the existing LangGraph.js codebase,
identifying exactly where changes are needed, what can be reused, and where
the hard problems are.

### 10.1 What Already Exists

The codebase is surprisingly well-prepared. Many protocol concepts already
have direct implementation counterparts:

| Protocol Concept | Existing Implementation | Gap |
|------------------|------------------------|-----|
| **Namespace hierarchy** | `checkpointNamespace` in `PregelLoop` (split from `checkpoint_ns`) | Already exists; needs to be promoted from internal to protocol-visible |
| **Stream modes as channels** | `StreamMode` type, `stream.modes` set, `_emit` filters by mode | Direct mapping; extend the set with new channel names |
| **Subgraph event merging** | `createDuplexStream` + `CONFIG_KEY_STREAM` injection | Already works; subscription filtering layers on top |
| **Event shape** | `StreamChunk = [namespace, mode, payload]` | Already the right shape; protocol events wrap this with timestamp |
| **SSE encoding** | `toEventStream()` with `event: mode\|ns` format | Works today; subscription filtering goes upstream |
| **Callback-based handlers** | `StreamMessagesHandler`, `StreamToolsHandler` push to stream | Extend pattern for new channels |
| **Custom writer** | `config.writer` → `stream.push([ns, "custom", chunk])` | Already the right pattern for custom channels |
| **Interrupt/resume** | `interrupt()` → `GraphInterrupt` → `Command({ resume })` | Full HITL flow exists; protocol wraps it in-band |
| **Store access** | `BaseStore` with namespace KV + vector search | Full API exists; protocol exposes it as commands |
| **Checkpoint history** | `checkpointer.list()`, `getState()`, `updateState()` | Exists in SDK; protocol wraps as `state.*` commands |
| **SSE retry + resume** | `streamWithRetry` tracks `lastEventId`, `Last-Event-ID` header | Foundation for `subscription.reconnect` |
| **SDK client structure** | `Client` facade with sub-clients (`runs`, `threads`, `store`) | Natural extension point for protocol client |

### 10.2 Core Runtime Changes (langgraph-core)

#### Subscription Registry — New Component

The most significant new component. Sits between `_emit` and `stream.push`:

```
  PregelLoop._emit()
       │
       ▼
  SubscriptionRegistry.dispatch(namespace, mode, payload)
       │
       ├── subscription A matches? → stream A .push()
       ├── subscription B matches? → stream B .push()
       └── no match → drop (never serialized)
```

**Where it hooks in**: `IterableReadableWritableStream.push()` at
`stream.ts:141`. Today every chunk goes through `passthroughFn` then
`controller.enqueue`. The registry replaces this with per-subscription
dispatch.

**Complexity**: Medium. The registry itself is a simple data structure
(list of `{ id, channels, namespaces, depth }` with prefix matching).
The harder part is that `createDuplexStream` in `loop.ts:151-162`
currently fans out by mode only — it needs to also carry subscription
context so nested subgraphs only push to matching subscriptions.

#### Event Buffer — New Component

Stores recent events for replay on new subscriptions and reconnection.
Bounded ring buffer with configurable capacity.

**Where it hooks in**: Between `SubscriptionRegistry.dispatch` and the
actual stream push. Every event that passes any subscription is also
appended to the buffer. On new subscription, matching events from the
buffer are replayed.

**Complexity**: Low for the buffer itself. The snapshot-drain race
condition (from Codex analysis) adds subtlety: during replay, new events
must be queued and drained after replay completes before switching to
live delivery.

#### Lifecycle Events — Small Extension

Emit `lifecycle.spawned` / `lifecycle.completed` / `lifecycle.failed`
events from existing code paths.

**Where it hooks in**:
- **Spawned**: `PregelLoop.initialize()` at `loop.ts:405` — when a
  nested graph's stream is duplexed, emit a lifecycle event.
- **Completed/Failed**: `PregelRunner._commit()` at `runner.ts:359` —
  task completion already calls `nodeFinished` callback (line 380).
  Extend this to emit lifecycle events to the stream.

**Complexity**: Low. The integration points already exist; this is
adding `stream.push([ns, "lifecycle", { event: "..." }])` calls.

#### Session Wrapper — New Component

The `createSession()` API from section 6.1.1. Wraps `_streamIterator`
with subscription management and command dispatch.

**Where it hooks in**: New file alongside `pregel/index.ts`. Calls
`_streamIterator` internally, wraps the returned stream with a
`SubscriptionRegistry`, and exposes typed methods.

**Complexity**: Medium. The Session needs to manage the lifecycle of
subscriptions (create/destroy async iterators), handle the
concurrent-consumers pattern (multiple `for await` loops on different
subscriptions), and clean up when the run completes.

### 10.3 Compatibility with `graph.stream()`

`graph.stream()` continues to work unchanged. Internally, it becomes
equivalent to:

```typescript
// What graph.stream(input, { streamMode: ["messages"], subgraphs: true }) does:
const session = createSession(graph, { input, config });
const globalSub = session.subscribe(["messages"]);  // No namespace filter = global
for await (const event of globalSub) {
  yield formatForBackwardCompat(event, streamMode, subgraphs);
}
```

The existing `_streamIterator` at `index.ts:2181-2205` already does
mode filtering and yield-shape formatting. The session wraps this
without changing it.

### 10.4 Changes by File

| File | Change | Scope |
|------|--------|-------|
| `pregel/stream.ts` | Add `SubscriptionRegistry`, `EventBuffer` classes. Modify `push()` to dispatch through registry. | ~200-300 lines new |
| `pregel/loop.ts` | Emit lifecycle events from `initialize()`. Pass subscription context through `createDuplexStream`. | ~30 lines modified |
| `pregel/runner.ts` | Emit lifecycle events from `_commit()`. | ~10 lines added |
| `pregel/index.ts` | Add `createSession()` factory. Wire `SubscriptionRegistry` into `_streamIterator`. | ~150 lines new |
| `pregel/types.ts` | Add new `StreamMode` values (`"lifecycle"`, `"resource"`, `"sandbox"`, `"input"`, `"state"`, `"usage"`). Add `SubscriptionOptions` type. | ~30 lines added |
| `pregel/session.ts` | **New file**: `Session` class with `subscribe()`, command methods, cleanup. | ~300-400 lines new |
| `pregel/protocol/` | **New directory**: Command handlers for `resource.*`, `sandbox.*`, `input.*`, `state.*`, `usage.*`. Each is an independent module. | ~100-200 lines per module |

### 10.5 What Is Hard

**1. Subscription-aware duplex streaming** — The current `createDuplexStream`
fans out by mode only. Adding namespace-aware filtering to the fan-out
path without breaking the subgraph event merging semantics requires
careful thought. The nested stream needs to know which subscriptions
exist at the root level so it can skip pushing events that no one is
listening to.

**2. Multiple concurrent async iterators** — The `Session.subscribe()`
API returns independent async iterators. JavaScript's `ReadableStream`
supports only one reader at a time. The session needs to either use
a pub/sub pattern internally (one producer, N consumers via separate
queues) or create separate `ReadableStream` instances per subscription.
The `IterableReadableWritableStream` class would need to be extended or
complemented with a multi-consumer variant.

**3. Sandbox and resource integration** — The `resource.*` and
`sandbox.*` modules depend on having access to the agent's execution
environment (file system, shell). For in-process agents, this is
straightforward (Node.js `fs` and `child_process`). For remote agents
running in Modal/Daytona/E2B, it requires a bridge between the protocol
server and the sandbox API. This bridge is deployment-specific and
cannot be fully specified in `langgraph-core`.

**4. Binary frame support** — WebSocket binary frames require a
WebSocket transport implementation, which does not exist in the codebase
today (it's SSE-only). The `ws` library or the native `WebSocket` API
would need to be integrated for the server side. The 16-byte binary
header serialization is trivial, but the transport layer is new
infrastructure.

### 10.6 What Is Straightforward

**1. Lifecycle events** — Just `stream.push()` calls at existing
integration points. The `nodeFinished` callback pattern in `runner.ts`
already demonstrates the exact hook.

**2. Input module** — `interrupt()` and `Command({ resume })` already
implement the full HITL flow. The protocol's `input.requested` /
`input.respond` is a thin wrapper that emits the interrupt as a
protocol event and routes the response back as a `Command`.

**3. State module** — `BaseStore` already has `get`, `search`, `put`,
`listNamespaces`. The checkpointer has `list()` for checkpoint history.
These are direct pass-throughs from protocol commands to existing APIs.

**4. Usage module** — Token/cost data is available in LangChain's
callback metadata (`ls_provider`, `ls_model_name`, token counts). The
`StreamMessagesHandler` already extracts metadata from callbacks. A
`StreamUsageHandler` following the same pattern would capture usage
data and emit `usage.llmCall` events.

**5. Event buffer** — A bounded array with an append cursor. The
replay logic is: filter buffer by subscription criteria, yield matches,
then drain any new events that arrived during replay.

**6. Backward compatibility** — `graph.stream()` doesn't change. The
new API is additive. Existing tests continue to pass without
modification.

---

## 11. Comparison to Other Streaming Protocols

### 11.1 Vercel AI SDK Stream Protocol

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

### 11.2 Anthropic Messages Streaming

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

### 11.3 OpenAI Realtime API

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

### 11.4 A2A Protocol (Revisited for Multimodal)

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

### 11.5 Codex Multi-Agent ("Collab") Architecture

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

### 11.6 Summary: Protocol Positioning

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
| **File system access** | No | N/A | No | No | No | No | Via tools (not protocol) | `resource` module (list/read/write/download + change events) |
| **Sandbox shell** | No | N/A | No | No | No | No | Via events (protocol) | `sandbox` module (live stdout/stderr + input/kill) |
| **Human-in-the-loop** | Separate API | N/A | No | No | No | No | Via tools | `input` module (request/respond/inject in-band) |
| **State/store access** | Separate API | N/A | No | No | No | No | No | `state` module (get/search/fork/checkpoint history) |
| **Cost tracking** | No | N/A | No | No | No | No | No | `usage` module (per-call + summary + budgets) |
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

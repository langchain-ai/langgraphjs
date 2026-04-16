# Streaming Protocol Examples

Standalone CLI scripts that demonstrate the `@langchain/langgraph-sdk` client
streaming API against a running LangGraph server. Each script opens a protocol
session, subscribes to one or more channels, sends input, and prints results to
the terminal.

## Prerequisites

Start the LangGraph server from the `ui-react-protocol` example root:

```bash
npx @langchain/langgraph-cli dev
```

Then run any example with:

```bash
npx tsx src/examples/<script>.ts
```

## Examples

### `stream-subgraph-messages.ts`

Discovers subgraphs via `subscribe("subgraphs")` and streams messages within
each one using `sub.subscribe("messages")`. Text deltas are rendered
token-by-token to stdout. Targets the `stategraph` agent.

**Key APIs:** `subscribe("subgraphs")`, `sub.subscribe("messages")`,
`StreamingMessage.text`

### `stream-subagent.ts`

Streams a single subagent's messages and tool calls from a deep agent run.
Subscribes to `"subagents"`, then opens parallel `"messages"` and `"toolCalls"`
subscriptions on the first discovered subagent. Targets the `deep-agent` agent.

**Key APIs:** `subscribe("subagents")`, `sub.subscribe("messages")`,
`sub.subscribe("toolCalls")`

### `deep-agent-overview.ts`

Collects all subagents and their tool calls from a multi-subagent run. Each
discovered subagent gets a parallel `"toolCalls"` subscription that tracks tool
names and statuses. Prints a summary when all subagents complete. Targets the
`deep-agent` agent.

**Key APIs:** `subscribe("subagents")`, `sub.subscribe("toolCalls")`,
`sub.taskInput`, `sub.output`

### `subagent-status-tracker.ts`

Tracks subagent lifecycle (spawned/running/completed/failed) without subscribing
to heavy channels like messages or values. Uses raw lifecycle events to maintain
a status map and prints a running count as subagents progress. Targets the
`deep-agent` agent.

**Key APIs:** `subscribe({ channels: ["lifecycle"] })`, lifecycle event filtering

### `human-in-the-loop.ts`

Detects an interrupt during a run, inspects the pending action, and resumes with
an approval. A single `"values"` subscription survives across the interrupt and
resumed run without re-subscribing. Targets the `human-in-the-loop` agent.

**Key APIs:** `subscribe("values")`, `session.interrupted`,
`session.interrupts`, `session.input.respond()`

# In-Process Streaming Examples

Runnable examples demonstrating `graph.streamEvents(..., { version: "v3" })` — the ergonomic in-process
streaming API for LangGraph.

## Setup

```bash
# From the monorepo root
pnpm install

# Set your API key
export ANTHROPIC_API_KEY=sk-...
```

## Examples

Each example is a self-contained script that can be run with `npx tsx`.

### `basic.ts` — Protocol event iteration

The simplest starting point. Iterates all `ProtocolEvent` objects from a tool-calling
graph and awaits the final output.

```bash
npx tsx src/basic.ts
```

Shows: `for await (const event of run)`, `await run.output`

### `messages.ts` — Streaming text tokens

Demonstrates the `.messages` projection. Each yielded `ChatModelStream` exposes
`.text` as both an `AsyncIterable<string>` (for token-by-token streaming) and a
`PromiseLike<string>` (for the full text). Also shows `.usage` for token counts.

```bash
npx tsx src/messages.ts
```

Shows: `run.messages`, `message.text`, `message.usage`

### `subgraphs.ts` — Recursive subgraph observation

A research pipeline with two sequential subgraphs (researcher → analyst). Shows
three ways to observe the subgraph tree:

1. Flat event stream — all events, dispatched by `event.method`
2. Subgraph discovery — `run.subgraphs` yields `SubgraphRunStream` per child
3. Concurrent consumption — messages and subgraphs consumed in parallel

```bash
npx tsx src/subgraphs.ts
```

Shows: `run.subgraphs`, `sub.messages`, `sub.name`, `sub.index`, recursive walking

### `custom-reducer.ts` — Domain-specific projections

Extends `streamEvents(..., { version: "v3" })` with a custom `StreamTransformer` that counts tool calls and
tracks token usage. The transformer is passed via the `transformers` option; its
projections appear on `run.extensions`.

```bash
npx tsx src/custom-reducer.ts
```

Shows: `StreamTransformer`, `graph.streamEvents(input, { version: "v3", transformers: [...] })`, `run.extensions`

### `parallel.ts` — Concurrent projection consumption

All projections on `GraphRunStream` share local stream channels, so
multiple `for await` loops can run concurrently without interference. This
example streams messages, counts state snapshots, and counts raw protocol
events in parallel via `Promise.all`.

```bash
npx tsx src/parallel.ts
```

Shows: `Promise.all([run.messages, run.values, run])`, independent cursors

### `human-in-the-loop.ts` — Interrupt, inspect, resume

Demonstrates the `streamEvents(..., { version: "v3" })` interrupt/resume lifecycle using a planner →
approval → executor graph. Turn 1 runs until `interrupt()` is called; the
example inspects `run.interrupted` and `run.interrupts`, then resumes with
`Command({ resume })` in turn 2.

```bash
npx tsx src/human-in-the-loop.ts
```

Shows: `interrupt()`, `run.interrupted`, `run.interrupts`, `Command({ resume })`, multi-turn `streamEvents(..., { version: "v3" })`

### `a2a.ts` — A2A protocol over a deployed server

End-to-end deployment example for custom stream transformers. The research
pipeline is compiled with an A2A transformer (`createA2ATransformer`) that emits
A2A-formatted status updates and artifacts. The graph is deployed via the
LangGraph dev server, and the SDK client subscribes to the `custom` channel
to receive only A2A events.

```bash
npx tsx src/a2a.ts
```

Shows: `.compile({ transformers: [createA2ATransformer] })`, `streamStateV2()`, SDK `client.runs.stream()`, `streamMode: ["custom"]`

## Agents

The example agents live in `src/agents/` and `src/a2a/`:

| Agent | File | Description |
|-------|------|-------------|
| Simple tool graph | `agents/simple-tool-graph.ts` | Single ReAct loop with search + calculator |
| Research pipeline | `agents/research-pipeline.ts` | Two sequential subgraphs with separate tools |
| Approval graph | `agents/approval-graph.ts` | Planner → human approval → executor with interrupt/resume |
| A2A research | `a2a/agent.ts` | Research pipeline with A2A stream transformer at compile time |

## API Surface

All examples use the `GraphRunStream` returned by
`graph.streamEvents(..., { version: "v3" })`:

```typescript
const run = await graph.streamEvents(input, { ...options, version: "v3" });

// Iterate all protocol events
for await (const event of run) { ... }

// Stream AI messages with text/reasoning/usage projections
for await (const msg of run.messages) {
  for await (const token of msg.text) { process.stdout.write(token); }
  const fullText = await msg.text;
  const usage = await msg.usage;
}

// Observe subgraphs recursively
for await (const sub of run.subgraphs) {
  console.log(sub.name, sub.path);
  for await (const msg of sub.messages) { ... }
}

// Final output
const state = await run.output;

// State snapshots per step
for await (const snapshot of run.values) { ... }

// Messages from a specific node
for await (const msg of run.messagesFrom("agent")) { ... }

// Custom transformers
const run = await graph.streamEvents(input, {
  version: "v3",
  transformers: [myTransformer],
});
const custom = await run.extensions.myProjection;

// Human-in-the-loop
const run1 = await graph.streamEvents(input, { ...config, version: "v3" });
for await (const msg of run1.messages) { ... }
await run1.output;
if (run1.interrupted) {
  console.log(run1.interrupts);
  const run2 = await graph.streamEvents(
    new Command({ resume: userDecision }),
    { ...config, version: "v3" }
  );
}
```

## Coming Soon

Additional examples will be added for:

- `createAgent` — `AgentRunStream` with typed `run.toolCalls`
- `createDeepAgent` — `DeepAgentRunStream` with `run.subagents`
- Cancellation — `run.abort()`, `AbortSignal` passthrough

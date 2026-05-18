# Getting started

## Install

```bash
npm add @langchain/langgraph-sdk
# or
pnpm add @langchain/langgraph-sdk
# or
yarn add @langchain/langgraph-sdk
```

The SDK targets modern runtimes (Node ≥ 18, evergreen browsers, Deno,
Bun, Cloudflare Workers, Vercel Edge). No additional polyfills are
required in environments that ship `fetch`, `ReadableStream`, and
`AbortController`.

## Create a client

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: "http://localhost:2024",
});
```

With zero arguments, the client defaults to `http://localhost:8123`
(the LangGraph dev server) and picks up an API key from the
`LANGGRAPH_API_KEY`, `LANGSMITH_API_KEY`, or `LANGCHAIN_API_KEY`
environment variables. See [Configuration](./configuration.md) for the
full option bag.

## Your first request

### Discover an assistant

A fresh LangGraph project auto-creates one assistant per graph
registered in `langgraph.json`. List them:

```ts
const assistants = await client.assistants.search({ limit: 10 });
const agent = assistants[0];
console.log(agent.assistant_id, agent.graph_id);
```

### Stream a run (recommended)

Use `client.threads.stream(...)` — the v2 thread-centric streaming API:

```ts
const thread = client.threads.stream({ assistantId: agent.assistant_id });

await thread.run.start({
  input: { messages: [{ role: "user", content: "what's 42 * 17?" }] },
});

for await (const message of thread.messages) {
  for await (const token of message.text) {
    process.stdout.write(token);
  }
  process.stdout.write("\n");
}

console.log("final state:", await thread.output);
await thread.close();
```

`thread.messages`, `thread.values`, `thread.toolCalls`, `thread.subgraphs`,
and `thread.extensions.<name>` are lazy — only the projections you
actually touch are streamed across the wire. Everything is covered in
detail in [Streaming](./streaming.md).

### Call a non-streaming API

Every sub-client also exposes plain async methods for CRUD-style work:

```ts
const thread = await client.threads.create({ metadata: { topic: "math" } });
await client.threads.update(thread.thread_id, {
  metadata: { topic: "algebra" },
});
await client.store.putItem(["notes"], "first", {
  body: "thread opened",
});
```

See the sub-client guides under the [main index](./README.md#sub-clients).

## TypeScript support

Every response shape is fully typed. The `Client` constructor accepts
three type parameters for graph-specific state:

```ts
type State = { messages: BaseMessage[]; summary?: string };
type Update = Partial<State>;
type CustomEvent = { kind: "progress"; pct: number };

const client = new Client<State, Update, CustomEvent>({ apiUrl: "..." });

const state = await client.threads.getState<State>(threadId);
//    ^? ThreadState<State>
```

For streaming, use the generic on `threads.stream()` to type server-side
transformer projections end-to-end:

```ts
type Extensions = InferExtensions<[typeof myTransformer]>;
const thread = client.threads.stream<Extensions>({ assistantId: "agent" });
//    ^? ThreadStream<Extensions>
```

See [Custom transformers](./streaming-extensions.md) for details.

## What to read next

- [Configuration](./configuration.md) — tune `Client` for your
  environment.
- [Streaming](./streaming.md) — the recommended streaming primitive
  and its lazy projections.
- [Threads](./threads.md) — CRUD, state, history, checkpoints,
  pruning, and more.

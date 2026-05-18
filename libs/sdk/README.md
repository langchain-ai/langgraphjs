# `@langchain/langgraph-sdk`

The JavaScript / TypeScript SDK for talking to a LangGraph API server.
Use it to create and manage assistants, threads, runs, cron
schedules, and the KV store — and, most importantly, to **stream**
graph executions in real time.

📚 **[Full documentation](./docs/README.md)**

## Install

```bash
pnpm add @langchain/langgraph-sdk
# or: npm install @langchain/langgraph-sdk
# or: yarn add @langchain/langgraph-sdk
```

## Quick start

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

// Open a thread-centric stream (the recommended way to stream).
const thread = client.threads.stream({ assistantId: "my-agent" });

await thread.run.start({
  input: { messages: [{ role: "user", content: "hello" }] },
});

for await (const message of thread.messages) {
  for await (const token of message.text) {
    process.stdout.write(token);
  }
}

console.log(await thread.output);
await thread.close();
```

With no `apiUrl`, the SDK points at `http://localhost:2024` (the
default `langgraph dev` URL).

## What's in the SDK

| Sub-client           | Purpose                                                      | Docs                                         |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `client.threads`     | Create threads, manage state, and **stream** runs.           | [Threads](./docs/threads.md) · [Streaming](./docs/streaming.md) |
| `client.assistants`  | CRUD for assistants (schemas, graphs, versions).             | [Assistants](./docs/assistants.md)           |
| `client.runs`        | Trigger / join / cancel runs without streaming.              | [Runs (legacy)](./docs/runs.md)              |
| `client.crons`       | Schedule recurring runs.                                     | [Crons](./docs/crons.md)                     |
| `client.store`       | Namespaced KV + semantic store.                              | [Store](./docs/store.md)                     |

### Streaming

`client.threads.stream(...)` returns a [`ThreadStream`](./docs/streaming.md)
with typed, lazy projections for every aspect of a run:

- `thread.messages` / `thread.toolCalls` — assembled chat output.
- `thread.values` / `thread.output` — graph state and final answer.
- `thread.interrupts` / `thread.interrupted` — human-in-the-loop.
- `thread.subgraphs` / `thread.subagents` — nested / deep-agent work.
- `thread.extensions.<name>` — typed custom server projections.
- `thread.audio` / `thread.images` / `thread.video` / `thread.files`
  — media.

> **Deprecated.** The generator-based streaming APIs on
> `client.runs.*` (`stream`, `joinStream`) and `client.threads.joinStream`
> are preserved for backwards compatibility only. New code should use
> `client.threads.stream(...)`. See
> [Runs (legacy)](./docs/runs.md) for migration guidance.

### Transports

Streaming defaults to Server-Sent Events (SSE) over HTTP. You can
switch to WebSocket per-call or globally, or plug in a custom
`AgentServerAdapter`:

```ts
const thread = client.threads.stream({
  assistantId: "my-agent",
  transport: "websocket",
});
```

See [Transports](./docs/transports.md) for full details.

## Framework adapters

If you're building a UI, use the framework-specific packages that
wrap this SDK:

- [`@langchain/langgraph-sdk/react`](../sdk-react/docs/README.md)
- [`@langchain/langgraph-sdk/vue`](../sdk-vue/docs/README.md)
- [`@langchain/langgraph-sdk/svelte`](../sdk-svelte/docs/README.md)
- [`@langchain/langgraph-sdk/angular`](../sdk-angular/docs/README.md)

Use the SDK directly when you need low-level control, run it from a
non-browser environment (Node.js server, edge workers, scripts), or
integrate into a framework that does not yet have a first-party
adapter.

## Architecture

The client code is organized into sub-client modules under
`src/client/`:

| Path                | Module                                                                            |
| ------------------- | --------------------------------------------------------------------------------- |
| `client/assistants/`| `AssistantsClient`                                                                |
| `client/threads/`   | `ThreadsClient` (includes the v2 `stream(...)` primitive)                         |
| `client/runs/`      | `RunsClient` (legacy streaming + CRUD)                                            |
| `client/crons/`     | `CronsClient`                                                                     |
| `client/store/`     | `StoreClient`                                                                     |
| `client/stream/`    | `ThreadStream`, assemblers, transports                                            |
| `client/base.ts`    | `BaseClient`, shared config & helpers                                             |
| `client/index.ts`   | Main `Client` class & re-exports                                                  |

## Change log

See [CHANGELOG.md](https://github.com/langchain-ai/langgraphjs/blob/main/libs/sdk/CHANGELOG.md).

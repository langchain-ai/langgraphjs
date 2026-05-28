# `@langchain/langgraph-sdk`

The JavaScript / TypeScript SDK for talking to a LangGraph API server. Use
it to create and manage assistants, threads, runs, cron schedules, and the
KV store — and, most importantly, to **stream** graph executions in real
time.

If you're building a UI on top of LangGraph, the framework-specific
packages are thin wrappers around this SDK:

- [`@langchain/react`](../../sdk-react/docs/use-stream.md)
- [`@langchain/vue`](../../sdk-vue/docs/api-reference.md)
- [`@langchain/svelte`](../../sdk-svelte/docs/use-stream.md)
- [`@langchain/angular`](../../sdk-angular/docs/inject-stream.md)

Use the SDK directly when you need low-level control, run it from a
non-browser environment (Node.js server, edge workers, scripts), or
integrate into a framework that is not yet covered by a first-party
adapter.

## Table of contents

1. [Getting started](./getting-started.md) — install, create a `Client`,
   make your first request.
2. [Configuration](./configuration.md) — `apiUrl`, `apiKey`, headers,
   timeouts, retries, request hooks, and the `streamProtocol` flag.
3. **Streaming (recommended)**
   - [Overview](./streaming.md) — the `ThreadStream` primitive returned
     by `client.threads.stream(...)`.
   - [Messages & tokens](./streaming-messages.md) — stream text and
     reasoning deltas from chat models.
   - [Interrupts & human-in-the-loop](./streaming-interrupts.md) —
     pause, inspect, and resume runs.
   - [Subgraphs](./streaming-subgraphs.md) —
     observe nested work in fan-out graphs.
   - [Subagents](./streaming-subagents.md) —
     observe deepagents-specific `task`-tool workers.
   - [Custom transformers (extensions)](./streaming-extensions.md) —
     consume `custom:<name>` projections with end-to-end typing.
   - [Media blocks](./streaming-media.md) — audio, image, video, and
     file streams.
   - [Advanced: raw subscriptions](./streaming-advanced.md) —
     `subscribe()`, `onEvent()`, `state.*`, channel filters.
   - [Transports](./transports.md) — SSE, WebSocket, and custom
     `AgentServerAdapter`s.
4. **Sub-clients**
   - [Assistants](./assistants.md) — `client.assistants`.
   - [Threads](./threads.md) — `client.threads` (CRUD, state, history).
   - [Runs (legacy)](./runs.md) — `client.runs` **(deprecated for
     streaming; use [`client.threads.stream`](./streaming.md)
     instead)**.
   - [Cron jobs](./crons.md) — `client.crons`.
   - [KV store](./store.md) — `client.store`.

## Which API do I use for streaming?

The SDK ships with two generations of streaming APIs. **New code should
always use the v2 `client.threads.stream(...)` primitive.** The legacy
generators on `client.runs.*` are preserved for backwards compatibility
only.

- **Stream a run with typed projections:** [`client.threads.stream(...)`](./streaming.md) ✅ **recommended**
- **Stream messages token-by-token:** [`thread.messages`](./streaming-messages.md) ✅
- **Human-in-the-loop:** [`thread.interrupts` + `thread.input.respond(...)`](./streaming-interrupts.md) ✅
- **Subgraph tree:** [`thread.subgraphs`](./streaming-subgraphs.md) ✅
- **Deep-agent subagents:** [`thread.subagents`](./streaming-subagents.md) ✅
- **Custom server-side projections:** [`thread.extensions.<name>`](./streaming-extensions.md) ✅
- **Re-attach to an in-flight run:** `client.threads.stream(threadId, { assistantId })` ✅
- **`client.runs.stream(...)` / `runs.joinStream()`:** ⚠️ Legacy — see [Runs (legacy)](./runs.md) for migration guidance

## Quick peek

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

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

Continue with [Getting started](./getting-started.md).

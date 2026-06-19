# Streaming

`client.threads.stream(...)` is **the recommended way to stream a run**.
It returns a `ThreadStream` — a high-level handle around a thread-centric
v2 protocol connection — that mirrors the in-process
`graph.streamEvents(..., { version: "v3" })` API from `@langchain/langgraph`.

> **Deprecation notice.** The legacy generators on `client.runs.*`
> (`runs.stream`, `runs.joinStream`, `runs.wait`) and
> `client.threads.joinStream(...)` remain functional but are no longer
> the recommended path for new code. See [Runs (legacy)](./runs.md)
> for migration guidance.

## Opening a stream

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

// New thread — uuidv7 is generated client-side.
const thread = client.threads.stream({ assistantId: "my-agent" });

// Attach to an existing thread.
const reattached = client.threads.stream("8f4a…", { assistantId: "my-agent" });
```

The `ThreadStream` is alive from construction — but the underlying
wire connection is opened lazily (on the first command or the first
projection access). This means you can safely configure subscriptions
before any network I/O happens.

### Options

```ts
interface ThreadStreamOptions {
  assistantId: string;
  transport?: "sse" | "websocket" | AgentServerAdapter;
  fetch?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  startingCommandId?: number;
}
```

| Option              | Description                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `assistantId`       | **Required.** Assistant bound to the thread for its lifetime.                                              |
| `transport`         | `"sse"` (default), `"websocket"`, or a full [`AgentServerAdapter`](./transports.md) for a custom backend.  |
| `fetch`             | `fetch` override for the SSE transport (proxies, mocks). Ignored for WebSocket and custom adapters.        |
| `webSocketFactory`  | Factory used to construct the `WebSocket` (custom subprotocols, auth). Ignored for SSE / custom adapters.  |
| `startingCommandId` | Low-level: starting value for the internal command counter. Tests only.                                    |

See [Transports](./transports.md) for details and tradeoffs.

## Submitting work

```ts
await thread.run.start({
  input: { messages: [{ role: "user", content: "hello" }] },
  config: { configurable: { ... } },
  metadata: { source: "ui" },
});
```

`thread.run.start(params)` starts a run, or resumes an interrupted one
(server-side checkpoint state is always honored on the bound thread).
The assistant is fixed at construction time and is forwarded for you.

For human-in-the-loop flows, use `thread.input.respond(...)` instead —
see [Interrupts](./streaming-interrupts.md).

## The lazy projection pattern

Instead of consuming a firehose of protocol events, a `ThreadStream`
exposes **typed, lazy projections**. Each getter opens a scoped
subscription on first access and is cached thereafter:

| Getter                     | Type                                                    | Channel                   |
| -------------------------- | ------------------------------------------------------- | ------------------------- |
| `thread.messages`          | `AsyncIterable<StreamingMessage>`                       | `messages`                |
| `thread.values`            | `AsyncIterable<State> & PromiseLike<State>`             | `values`                  |
| `thread.output`            | `Promise<State>`                                        | `values`                  |
| `thread.toolCalls`         | `AsyncIterable<AssembledToolCall>`                      | `tools`                   |
| `thread.subgraphs`         | `AsyncIterable<SubgraphHandle>`                         | `lifecycle` + `tools`     |
| `thread.subagents`         | `AsyncIterable<SubagentHandle>` *(deepagents-specific)* | `lifecycle` + `tools`     |
| `thread.extensions.<name>` | `AsyncIterable<T> & PromiseLike<T>`                     | `custom:<name>`           |
| `thread.audio`             | `AsyncIterable<AudioMedia>`                             | `messages` (audio blocks) |
| `thread.images`            | `AsyncIterable<ImageMedia>`                             | `messages` (image blocks) |
| `thread.video`             | `AsyncIterable<VideoMedia>`                             | `messages` (video blocks) |
| `thread.files`             | `AsyncIterable<FileMedia>`                              | `messages` (file blocks)  |
| `thread.interrupts`        | `InterruptPayload[]` (synchronous)                      | `input`                   |
| `thread.interrupted`       | `boolean` (synchronous)                                 | `lifecycle`               |

Two concrete payoffs:

1. **Zero wire cost for data you don't consume.** A client that only
   reads `thread.values` doesn't open a `messages` subscription.
2. **Consistent access across time.** Read `thread.output` *before* you
   call `thread.run.start(...)` and it still resolves correctly —
   critical subscriptions (`values`, lifecycle) are eagerly bootstrapped
   from `run.start` / `input.respond`.

Each getter returns a **`MultiCursorBuffer`**: every `for await` loop
gets an independent cursor, so late consumers replay every item
previously emitted to the buffer.

```ts
// Two independent loops both see every message, past and future:
const showText = async () => {
  for await (const msg of thread.messages) console.log(await msg.text);
};
const countMessages = async () => {
  let n = 0;
  for await (const _ of thread.messages) n += 1;
  console.log("total:", n);
};
await Promise.all([showText(), countMessages()]);
```

## Example: end-to-end run

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = client.threads.stream({ assistantId: "simple-tool-graph" });

await thread.run.start({
  input: {
    messages: [{ role: "user", content: "What is 42 * 17?" }],
  },
});

// Consume several projections concurrently.
await Promise.all([
  (async () => {
    for await (const msg of thread.messages) {
      for await (const token of msg.text) process.stdout.write(token);
      process.stdout.write("\n");
    }
  })(),
  (async () => {
    for await (const tc of thread.toolCalls) {
      console.log(`tool ${tc.name}(${JSON.stringify(tc.input)})`);
      console.log(`  → ${await tc.status}: ${await tc.output}`);
    }
  })(),
]);

const finalState = (await thread.output) as { messages: { content: unknown }[] };
console.log("final answer:", finalState.messages.at(-1)?.content);

await thread.close();
```

## Lifecycle & interrupt state

Two always-on fields mirror the in-process API and require no opt-in:

```ts
thread.interrupted; // boolean — true after a `lifecycle: interrupted` event
thread.interrupts;  // InterruptPayload[] — populated on input.requested events
```

Lifecycle + interrupt tracking is bootstrapped from the first call to
`thread.run.start(...)` / `thread.input.respond(...)`. Use the
dedicated guide for details: [Interrupts](./streaming-interrupts.md).

## Ordering and replay

Every `ThreadStream` carries an `ordering` object:

```ts
thread.ordering.lastSeenSeq;           // monotonic seq of the last event observed
thread.ordering.lastEventId;           // last protocol event id
thread.ordering.lastAppliedThroughSeq; // last ack'd command cursor
```

These are primarily diagnostic — the SDK handles reconnects, replay,
and dedup internally. The server replays buffered events on every
new SSE connection; the SDK deduplicates by `event_id` per
subscription and globally for thread-level side effects.

## Closing

Always close the stream when you're done:

```ts
await thread.close();
```

`close()` is idempotent and tears down:

- All open subscriptions.
- The shared SSE stream / WebSocket connection.
- Any live media object URLs minted by audio / image / video / file
  handles (safety net — consumers should also call `revoke()`).
- Pending command promises (rejected so dangling awaits settle).

## What to read next

- **Common flows**
  - [Messages & tokens](./streaming-messages.md)
  - [Human-in-the-loop / interrupts](./streaming-interrupts.md)
- [Subgraphs](./streaming-subgraphs.md)
- [Subagents](./streaming-subagents.md)
  - [Custom transformer projections](./streaming-extensions.md)
  - [Media blocks](./streaming-media.md)
- **Advanced**
  - [Raw subscriptions & channels](./streaming-advanced.md)
  - [Transports (SSE, WebSocket, custom)](./transports.md)

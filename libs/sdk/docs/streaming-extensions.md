# Custom transformers (extensions)

Graphs compiled with
[`StreamTransformer`s](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/src/stream/types.ts)
attach projections that run server-side. Streaming projections backed by
`StreamChannel.remote(name)` are forwarded to clients on a protocol
`custom:<name>` channel as values arrive; final-value promises are flushed on
run end. The SDK surfaces both as **extensions** on `ThreadStream`:

```ts
const handle = thread.extensions.toolActivity;
//   ^? ThreadExtension<unknown>  (narrow with a generic; see below)
```

A `ThreadExtension<T>` is both:

- `AsyncIterable<T>` — iterate values as they are emitted.
- `PromiseLike<T>` — `await` resolves with the **last** value observed
  before the run terminates.

That dual shape mirrors the in-process `run.extensions.<name>` API, so
the same consumer code works for streaming (`StreamChannel.remote`) and
final-value transformers without changes. Use `StreamChannel.local()` for
in-process-only extension streams that should not cross the wire.

## End-to-end type safety

Use `InferExtensions<typeof yourTransformers>` from
`@langchain/langgraph` to drive the `ThreadStream` generic:

```ts
import type { InferExtensions } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";

import { statsTransformer, toolActivityTransformer } from "./transformers.js";

type Extensions = InferExtensions<
  [typeof statsTransformer, typeof toolActivityTransformer]
>;

const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = client.threads.stream<Extensions>({
  assistantId: "simple-tool-with-metrics",
});

// Now:
//   thread.extensions.toolActivity  → ThreadExtension<{ name, status }>
//   thread.extensions.totalTokens   → ThreadExtension<number>
//   thread.extensions.toolCallCount → ThreadExtension<number>
```

`ThreadStream<TExtensions>` internally unwraps in-process projection
shapes:

- `Promise<T>` / `PromiseLike<T>` → `T`
- `StreamChannel<T>` / `AsyncIterable<T>` → `T`

So the remote and in-process code share one set of types.

## Streaming example

```ts
await thread.run.start({
  input: { messages: [{ role: "user", content: "What's 12 * 12?" }] },
});

await Promise.all([
  (async () => {
    for await (const msg of thread.messages) {
      console.log(await msg.text);
    }
  })(),
  (async () => {
    for await (const activity of thread.extensions.toolActivity) {
      console.log(`[tool] ${activity.name} → ${activity.status}`);
    }
  })(),
]);

console.log("tool calls:", await thread.extensions.toolCallCount);
console.log("total tokens:", await thread.extensions.totalTokens);

await thread.close();
```

## Lazy subscriptions + server-side replay

A key subtlety: **the shared `custom` subscription is opened lazily**
on first access to any `thread.extensions.<name>` handle. Runs that
never touch extensions pay zero subscription cost.

When you access an extension *after* the run has already emitted
events, the server replays matching events from its per-session event
buffer, so the handle's iterator and its `await` side still see every
past payload. You can create handles before, during, or after the run
and get correct results.

```ts
// Order-independent.
const stats = thread.extensions.statsTransformer;

await thread.run.start({ input: { ... } });

// Accessing AFTER the run: the buffer replays every past payload.
console.log("toolActivity final:", await thread.extensions.toolActivity);
console.log("stats final:",        await stats);
```

## Named `custom:<name>` subscriptions

Under the hood, an extension handle is backed by a dispatcher that
listens on the `custom` channel and fans each event out to per-name
subscribers by `data.name`. If you need the raw protocol event instead
of the unwrapped payload, use
[`thread.subscribe("custom:<name>")`](./streaming-advanced.md):

```ts
const handle = await thread.subscribe("custom:toolActivity");
for await (const payload of handle) {
  // `payload` is the `.payload` property of the custom event.
}

// Pass a full SubscribeParams object to get the full event envelope.
const raw = await thread.subscribe({ channels: ["custom:toolActivity"] });
for await (const event of raw) {
  console.log(event.method, event.params.namespace, event.params.data);
}
```

`thread.extensions.<name>` is the preferred high-level path; raw
subscriptions are for advanced cases (custom routing, tracing,
selector-based re-rendering).

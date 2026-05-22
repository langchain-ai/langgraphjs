# Advanced streaming

This guide covers the lower-level building blocks that power the
high-level `ThreadStream` projections: raw channel subscriptions,
`onEvent` listeners, and the `state.*` module for checkpoint work.

Reach for these when:

- You're building your own projection (custom selector hooks, cursors,
  tracing).
- You need an event the high-level projections don't expose.
- You're integrating the SDK with a non-JS/TS runtime where the typed
  projections aren't available.

## Channels and events

The v2 protocol organises server → client events into **channels**:

| Channel        | Event method          | Payload                                            |
| -------------- | --------------------- | -------------------------------------------------- |
| `values`       | `values`              | State snapshots after each super-step.             |
| `updates`      | `updates`             | Partial state updates from each node.              |
| `messages`     | `messages`            | Chat-model message / content-block events.         |
| `tools`        | `tools`               | `tool-started` / `tool-finished` / `tool-error`.   |
| `custom`       | `custom`              | `StreamTransformer` outputs (`custom:<name>`).     |
| `lifecycle`    | `lifecycle`           | `started`, `completed`, `interrupted`, `failed`.   |
| `input`        | `input.requested`     | HITL interrupt requests.                           |
| `debug`        | `debug`               | Runtime diagnostics.                               |
| `checkpoints`  | `checkpoints`         | Checkpoint ids as they are written.                |
| `tasks`        | `tasks`               | Task-level events (super-step scheduling).         |

Subscribing to a channel opens a filtered stream on the server-side
session that delivers matching events to you in order.

## `thread.subscribe(...)`

Three overloads:

```ts
// Single channel — yields the typed event for that channel.
const sub = await thread.subscribe("messages");
for await (const event of sub) {
  event.method === "messages"; // true
}

// Array of channels — yields the union event type.
const mix = await thread.subscribe(["messages", "tools"]);
for await (const event of mix) { ... }

// Full SubscribeParams object — most control.
const scoped = await thread.subscribe({
  channels: ["lifecycle", "tools"],
  namespaces: [["researcher"]],  // only the "researcher" subgraph
  depth: 1,                       // at most 1 level below each prefix
});
```

### `SubscribeOptions`

When passing a channel string / array, the second argument is a
`SubscribeOptions` object (`SubscribeParams` minus `channels`):

| Field        | Type                     | Meaning                                                                       |
| ------------ | ------------------------ | ----------------------------------------------------------------------------- |
| `namespaces` | `readonly string[][]`    | List of namespace prefixes. `undefined` = wildcard (every namespace).         |
| `depth`      | `number`                 | Maximum depth below each prefix. `undefined` = unbounded.                     |

Examples:

```ts
// Every message event, at any depth, in any namespace.
await thread.subscribe("messages");

// Only the root namespace (depth 0).
await thread.subscribe("values", { namespaces: [[]], depth: 0 });

// Every descendant of the "researcher" subagent, up to 2 levels deep.
await thread.subscribe("messages", { namespaces: [["researcher"]], depth: 2 });
```

### `custom:<name>` shortcut

Subscribing to a string that starts with `custom:` automatically
**unwraps the payload** — you receive the inner data, not the
protocol envelope:

```ts
const activity = await thread.subscribe("custom:toolActivity");
for await (const payload of activity) {
  console.log(payload.name, payload.status);
}
```

If you pass the channel via the `SubscribeParams` object overload,
you get the raw `Event` (including `params.namespace`, `data.name`,
etc.). That is useful when you need to discriminate on custom event
metadata.

### The handle

`thread.subscribe(...)` returns a `SubscriptionHandle`:

```ts
interface SubscriptionHandle<TEvent, TYield = TEvent> {
  readonly subscriptionId: string;
  readonly params: SubscribeParams;
  unsubscribe(): Promise<void>;
  pause(): void;
  resume(): void;
  [Symbol.asyncIterator](): AsyncIterator<TYield>;
}
```

Closing the handle (`unsubscribe()`) is the only way to drop a user
subscription — `thread.close()` closes them all for you.

## `thread.onEvent(listener)`

Fires **once per globally unique `event_id`** across both the content
pump and the lifecycle watcher:

```ts
const dispose = thread.onEvent((event) => {
  if (event.method === "lifecycle") {
    console.log("lifecycle:", event.params.data.event);
  }
});

// Later:
dispose();
```

Use cases:

- Discovery runners (walking every `lifecycle.started` for graph
  reconstruction).
- Tracing / metrics pipelines.
- Capturing events from deeply nested subgraphs without widening the
  content pump's filter.

`onEvent` is fire-and-forget: a listener that throws is swallowed; it
never blocks delivery to other listeners or to subscriptions.

## Reading checkpoint state: `thread.state.*`

`ThreadStream` exposes a small state module that mirrors
`graph.state.*` in-process:

```ts
thread.state.get(params);             // current state at checkpoint
thread.state.listCheckpoints(params); // enumerate checkpoints
thread.state.fork(params);            // fork from a checkpoint
```

Full shapes come from the `@langchain/protocol` package
(`StateGetParams`, `StateForkParams`, `ListCheckpointsParams`).

Typical usage:

```ts
const checkpoints = await thread.state.listCheckpoints({ limit: 10 });
const state = await thread.state.get({
  checkpoint_id: checkpoints.checkpoints[0].id,
});
```

For CRUD-style history outside an active stream, use
[`client.threads.getHistory(...)`](./threads.md#history) instead.

## Lower-level entry points: `submitRun` and `respondInput`

`thread.run.start` and `thread.input.respond` pre-open a handful of
lazy projections (`values`, lifecycle) so that ergonomic getters
always resolve correctly. When you want strict control over what gets
subscribed — for example inside a custom framework adapter — use the
narrower entry points:

| Method                        | Opens lazy `values`? | Opens lifecycle tracking? |
| ----------------------------- | -------------------- | ------------------------- |
| `thread.run.start(...)`       | ✅                   | ✅ (wildcard)             |
| `thread.input.respond(...)`   | ✅                   | ✅ (wildcard)             |
| `thread.submitRun(...)`       | ❌                   | ✅ (dedicated watcher)    |
| `thread.respondInput(...)`    | ❌                   | ✅ (dedicated watcher)    |

The dedicated watcher runs alongside a narrow content pump so callers
that manage their own subscriptions don't widen the shared SSE filter.
This is what the framework packages' `StreamController` uses under
the hood.

## `client.stream.matchesSubscription` and `inferChannel`

Two small utilities are re-exported for framework authors:

- `matchesSubscription(event, params)` — decide whether an event
  satisfies a `SubscribeParams` (channel + namespace prefix + depth).
- `inferChannel(event)` — derive the channel name (`"messages"`,
  `"custom:foo"`, …) from a protocol `Event`.

These are the same predicates the SDK uses for subscription fan-out.

## Composing a `ThreadStream` by hand

`ThreadStream` accepts any `TransportAdapter` / `AgentServerAdapter`
directly, so you can compose a stream with a custom transport without
going through `client.threads.stream(...)`. See the
[Transports guide](./transports.md#standalone-use-with-threadstream)
for examples.

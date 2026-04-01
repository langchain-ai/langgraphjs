# @langchain/client

Typed runtime client for the LangChain session-based streaming protocol.

This package is the low-level building block for talking to the protocol over
custom or built-in transports. It is designed for SDK authors, runtime
integrators, and advanced applications that want direct access to typed
protocol commands, events, subscriptions, and message assembly.

If you want a higher-level API client for LangGraph servers, use
`@langchain/langgraph-sdk` instead. If you want React bindings on top of this
protocol, use `@langchain/react`.

## Installation

```bash
pnpm add @langchain/client @langchain/protocol
```

## What You Get

- `ProtocolClient` to open a protocol session over a custom or built-in transport
- `ProtocolSseTransportAdapter` for HTTP commands plus SSE event delivery
- `ProtocolWebSocketTransportAdapter` for bidirectional WebSocket delivery
- `Session` with typed command helpers and capability checks
- `SubscriptionHandle` for raw protocol events
- `MessageSubscriptionHandle` for fully assembled message outputs
- `MessageAssembler` for custom message-stream processing
- `ProtocolError` for structured protocol command failures
- `TransportAdapter` so you can plug in HTTP, SSE, WebSocket, in-process, or
  test transports

## When To Use This Package

Use `@langchain/client` when you need to:

- implement a custom protocol transport
- reuse built-in protocol SSE or WebSocket transports in another SDK/runtime
- consume the session protocol directly instead of going through a REST SDK
- build a UI or runtime that needs typed event subscriptions
- reconstruct final messages from streamed `messages` events
- manage reconnect and event-ordering state yourself

Reach for a higher-level package when you want:

- REST endpoints, assistants, threads, and runs via `@langchain/langgraph-sdk`
- React hooks and UI streaming via `@langchain/react`

## Quick Start

At a high level:

1. choose a built-in transport or implement `TransportAdapter`
2. create a `ProtocolClient`
3. open a `Session`
4. subscribe to channels
5. send commands such as `run.input`
6. close subscriptions and the session when finished

```ts
import {
  ProtocolClient,
  ProtocolSseTransportAdapter,
} from "@langchain/client";

const client = new ProtocolClient(
  () =>
    new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:2024",
    }),
  { eventBufferSize: 1024 },
);

const session = await client.open({
  protocolVersion: "0.3.0",
  target: { kind: "agent", id: "my-agent" },
  preferredTransports: ["sse-http"],
});

const subscription = await session.subscribe(["messages", "lifecycle"]);

try {
  const { runId } = await session.run.input({
    input: {
      messages: [{ role: "user", content: "Hello!" }],
    },
  });

  console.log("run started:", runId);

  for await (const event of subscription) {
    console.log(event.method, event.params);

    if (
      event.method === "lifecycle" &&
      (event.params.data.event === "completed" ||
        event.params.data.event === "failed" ||
        event.params.data.event === "interrupted")
    ) {
      break;
    }
  }
} finally {
  await subscription.unsubscribe().catch(() => undefined);
  await session.close().catch(() => undefined);
}
```

If you need a non-standard runtime or transport layer, you can still implement
`TransportAdapter` yourself and pass it to `ProtocolClient`.

## Core Types

### `ProtocolClient`

`ProtocolClient` owns transport creation and opens new sessions.

```ts
const client = new ProtocolClient(transportFactory, {
  eventBufferSize: 512,
  startingCommandId: 1,
});
```

Options:

- `eventBufferSize`: number of recent events retained for replay to new
  subscriptions. Defaults to `512`.
- `startingCommandId`: initial numeric command ID. Useful if your environment
  coordinates command IDs externally.

The constructor accepts either:

- a concrete `TransportAdapter`
- a function returning a `TransportAdapter` or `Promise<TransportAdapter>`

### `Session`

`client.open()` returns a `Session`, which is the main API surface for sending
commands and receiving events.

Always-available session properties:

- `session.sessionId`: protocol session identifier
- `session.capabilities`: server-advertised capability graph
- `session.transport`: transport profile returned by the server
- `session.ordering`: last observed ordering metadata
- `session.run.input(...)`
- `session.agent.getTree(...)`

Optional command groups are only attached when the server advertises those
modules:

- `session.resource`
- `session.sandbox`
- `session.input`
- `session.state`
- `session.usage`

Important helper methods:

- `session.describe()`
- `session.close()`
- `session.subscribe(...)`
- `session.subscribeMessages(...)`
- `session.reconnect(...)`
- `session.supportsChannel(channel)`
- `session.supportsCommand(method)`
- `session.assertSupportsChannel(channel)`
- `session.assertSupportsCommand(method)`

### `TransportAdapter`

`TransportAdapter` is the only abstraction this package requires you to
implement:

```ts
interface TransportAdapter {
  open(params: SessionOpenParams): Promise<SessionResult>;
  send(command: Command): Promise<CommandResponse | ErrorResponse | void>;
  events(): AsyncIterable<Message>;
  close(): Promise<void>;
}
```

Semantics:

- `open(params)` performs the session-open handshake and returns the
  `SessionResult`
- `send(command)` may return an immediate success or error response
- `send(command)` may also return `undefined` when the response will be emitted
  later by `events()`
- `events()` must yield the protocol message stream for the session, including
  normal events and any deferred command responses
- `close()` should release all transport resources

Built-in transport implementations include:

- `ProtocolSseTransportAdapter`
- `ProtocolWebSocketTransportAdapter`

### Built-In Protocol Transports

`@langchain/client` ships reusable protocol-native transport adapters so
other SDKs do not need to reimplement the session handshake and event-stream
parsing logic.

#### `ProtocolSseTransportAdapter`

Use `ProtocolSseTransportAdapter` when your environment can issue HTTP requests
and consume `text/event-stream` responses:

```ts
import {
  ProtocolClient,
  ProtocolSseTransportAdapter,
} from "@langchain/client";

const client = new ProtocolClient(
  () =>
    new ProtocolSseTransportAdapter({
      apiUrl: "http://localhost:2024",
      defaultHeaders: {
        Authorization: `Bearer ${process.env.API_KEY}`,
      },
    }),
);
```

Options:

- `apiUrl`
- `defaultHeaders`
- `onRequest`
- `fetch`
- `fetchFactory`

#### `ProtocolWebSocketTransportAdapter`

Use `ProtocolWebSocketTransportAdapter` when the server and runtime prefer a
single bidirectional connection:

```ts
import {
  ProtocolClient,
  ProtocolWebSocketTransportAdapter,
} from "@langchain/client";

const client = new ProtocolClient(
  () =>
    new ProtocolWebSocketTransportAdapter({
      apiUrl: "http://localhost:2024",
    }),
);
```

Options:

- `apiUrl`
- `defaultHeaders`
- `onRequest`
- `webSocketFactory`

In browsers, standard `WebSocket` connections do not support arbitrary custom
headers. For that reason, the built-in WebSocket adapter rejects
`defaultHeaders` and `onRequest` when it is using the platform socket API.

## Session Lifecycle

### Opening A Session

`client.open(params)` forwards `SessionOpenParams` to the transport and returns
a typed `Session`.

Common fields when opening a LangGraph-backed session include:

- `protocolVersion`
- `target`, such as `{ kind: "agent", id: "my-agent" }`
- `preferredTransports`, such as `["sse-http"]` or `["websocket"]`
- `capabilities` to advertise the subset of commands and channels your client
  wants to use
- `config` for thread or runtime configuration

Example:

```ts
const session = await client.open({
  protocolVersion: "0.3.0",
  target: { kind: "graph", id: "stategraph_text" },
  preferredTransports: ["sse-http"],
  capabilities: {
    modules: [
      { name: "session", commands: ["open", "describe", "close"] },
      { name: "subscription", commands: ["subscribe", "unsubscribe", "reconnect"] },
      { name: "run", commands: ["input"] },
      { name: "messages", channels: ["messages"] },
      { name: "values", channels: ["values"] },
    ],
  },
});
```

### Capability Checks

`Session` validates advertised capabilities before sending most commands. If you
attempt to subscribe to a channel or invoke a command that the server did not
advertise, the client throws before sending the request.

That makes these helpers useful for feature-gated integrations:

```ts
if (session.supportsChannel("usage")) {
  const usageSubscription = await session.subscribe({
    channels: ["usage"],
  });
  await usageSubscription.unsubscribe();
}

if (session.usage) {
  // Safe to call usage commands here because the module was advertised.
  console.log("usage module available");
}
```

### Closing A Session

`session.close()`:

- sends `session.close`
- closes active subscriptions
- clears in-memory subscription state
- closes the underlying transport

Call it in a `finally` block whenever possible.

## Commands And Module Helpers

The `Session` surface maps protocol methods to typed helpers.

Always present:

- `session.run.input(params)`
- `session.agent.getTree(params?)`

Conditionally present when advertised:

- `session.resource.list(params)`
- `session.resource.read(params)`
- `session.resource.write(params)`
- `session.resource.download(params)`
- `session.sandbox.input(params)`
- `session.sandbox.kill(params)`
- `session.input.respond(params)`
- `session.input.inject(params)`
- `session.state.get(params)`
- `session.state.storeSearch(params)`
- `session.state.storePut(params)`
- `session.state.listCheckpoints(params)`
- `session.state.fork(params)`
- `session.usage.setBudget(params)`

The helpers preserve result types from `@langchain/protocol`, so the package is
well suited for strongly typed SDK internals.

## Subscriptions

### Raw Event Subscriptions

Use `session.subscribe()` when you want direct access to protocol events:

```ts
const subscription = await session.subscribe(["messages", "tools"], {
  namespaces: [["agent_1"]],
  depth: 1,
});

for await (const event of subscription) {
  console.log(event.method);
}
```

For the proposal-style channel-first API, single-channel subscriptions work too:

```ts
const messages = await session.subscribe("messages");
const tools = await session.subscribe("tools", {
  namespaces: [["agent_1", "researcher"]],
});
```

`SubscriptionHandle` is both:

- an `AsyncIterable<Event>`
- an object with `subscriptionId`, `params`, and `unsubscribe()`

### Filtering

Subscriptions are matched against:

- `channels`
- `namespaces`
- `depth`
- `mediaTypes`

The client also infers the protocol channel from each event method, so channel
filters work across `messages`, `tools`, `usage`, `state`, `sandbox`, `media`,
and other protocol event families.

### Buffered Replay

The client keeps a rolling event buffer in memory. When you create a new
subscription, matching buffered events are replayed into that subscription
immediately.

This is useful when:

- you subscribe after a run has already started
- you want short-lived consumers to catch up from recent activity
- you need reconnect-style replay from the client-side buffer

The buffer size is controlled by `ProtocolClient`'s `eventBufferSize` option.

### Reconnect

`session.reconnect()` lets you re-sync after a transport interruption using the
session's ordering metadata and known subscription IDs:

```ts
await session.reconnect({
  lastEventId: session.ordering.lastEventId,
  subscriptions: [subscription.subscriptionId],
});
```

If the server reports the reconnect was restored, the client replays locally
buffered matching events to active subscriptions.

## Assembled Messages

The raw `messages` channel is emitted as lifecycle fragments like
`message-start`, `content-block-delta`, and `message-finish`.

If you want complete finalized messages, use `session.subscribeMessages()`:

```ts
const messages = await session.subscribeMessages({
  namespaces: [[]],
});

for await (const message of messages) {
  console.log(message.finishReason);
  console.log(message.blocks);
}
```

`subscribeMessages()`:

- internally subscribes to the `messages` channel
- reconstructs content block deltas into final blocks
- yields only when a message finishes or errors
- returns `AssembledMessage` objects

`AssembledMessage` includes:

- `namespace`
- `node`
- `messageId`
- `metadata`
- `blocks`
- `usage`
- `finishReason`
- `finishMetadata`
- `error`

### Low-Level Message Assembly

If you want custom handling of partial message updates, use `MessageAssembler`
directly:

```ts
import { MessageAssembler } from "@langchain/client";

const assembler = new MessageAssembler();
const update = assembler.consume(messageEvent);

switch (update.kind) {
  case "message-start":
  case "content-block-start":
  case "content-block-delta":
  case "content-block-finish":
  case "message-finish":
  case "message-error":
    console.log(update.message);
    break;
}
```

This is useful for UIs that want to render in-progress content while still
keeping a normalized final message model.

## Errors

When the server sends a protocol error response, the client throws
`ProtocolError`.

```ts
import { ProtocolError } from "@langchain/client";

try {
  await session.run.input({
    input: { messages: [{ role: "user", content: "hello" }] },
  });
} catch (error) {
  if (error instanceof ProtocolError) {
    console.error(error.code);
    console.error(error.message);
    console.error(error.response);
  }
}
```

`ProtocolError` exposes:

- `name`
- `message`
- `code`
- `response`

Transport failures from `events()` or `send()` are surfaced as normal `Error`
instances.

## Ordering State

`session.ordering` tracks protocol ordering metadata as the session runs:

- `lastSeenSeq`: latest event sequence number observed from the event stream
- `lastAppliedThroughSeq`: latest command acknowledgement watermark returned by
  the server
- `lastEventId`: latest event ID observed from the event stream

These fields are updated automatically as events and command responses arrive.
They are particularly useful for reconnect logic and transport diagnostics.

## Practical Notes

- `session.run` and `session.agent` are always present as convenience objects,
  but calls still fail if the corresponding command was not advertised.
- Optional groups like `session.state` or `session.resource` only exist when the
  server advertises those modules.
- `SubscriptionHandle` and `MessageSubscriptionHandle` are async iterables, so
  they work naturally with `for await...of`.
- Returning early from a `for await...of` loop does not replace explicit
  cleanup. Prefer `unsubscribe()` and `session.close()` in `finally`.
- For browser WebSocket transports, be aware that the platform does not allow
  arbitrary custom headers on standard `WebSocket` connections.

## Related Packages

- `@langchain/protocol` for the shared protocol type definitions
- `@langchain/langgraph-sdk` for the higher-level LangGraph API client
- `@langchain/react` for React bindings built on top of this protocol layer

# Transports

`ThreadStream` talks to an agent server over a pluggable transport.
The SDK ships two built-in wire transports and an adapter seam for
custom backends:

| Transport                                  | When to use                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **SSE** (default)                          | HTTP commands + one Server-Sent-Events stream per subscription. Works in every browser.          |
| **WebSocket**                              | Single bidirectional connection. Lower overhead for long-lived sessions with many subscriptions. |
| **Custom `AgentServerAdapter`**            | Swap out the whole HTTP/WS layer — proxy, bridge to a non-LangGraph backend, etc.                |

## Choosing a transport

### Per-call override

```ts
const thread = client.threads.stream({
  assistantId: "my-agent",
  transport: "websocket", // or "sse"
});
```

### Client-wide default

Set `streamProtocol: "v2-websocket"` on the `Client`:

```ts
const client = new Client({
  apiUrl: "wss://example.com",
  streamProtocol: "v2-websocket",
});

// Now every `threads.stream(...)` call uses WebSocket by default.
const thread = client.threads.stream({ assistantId: "agent" });
```

A per-call `transport` still wins over `streamProtocol`.

## SSE transport

Uses a single shared SSE connection with a progressively-widening
subscription filter:

- Subscriptions are unioned into one filter; the SDK opens the
  narrowest stream that still covers every live subscription.
- When a subscription is added or removed, the stream rotates
  (open-before-close). The overlap is absorbed by per-subscription
  `event_id` dedup, so existing loops never see duplicates; late
  joiners receive the server's replay from `seq=0`.
- Command / response traffic goes over plain HTTP POSTs.

### Options passed through `threads.stream(...)`

| Option   | Effect                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------ |
| `fetch`  | Override the `fetch` implementation — handy for Next.js route handlers, auth proxies, or tests.  |

`defaultHeaders`, `onRequest`, and `apiKey` come from the parent
`Client` and are applied to every request automatically.

## WebSocket transport

A single bidirectional WebSocket multiplexes both commands and
events. The SDK sends a `subscription.subscribe` command per
subscription and the server delivers matching events back over the
same socket.

### Options passed through `threads.stream(...)`

| Option             | Effect                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `webSocketFactory` | Factory invoked with the resolved URL. Use this to pass subprotocols, auth headers, or testmocks. |

```ts
const thread = client.threads.stream({
  assistantId: "agent",
  transport: "websocket",
  webSocketFactory: (url) => new WebSocket(url, ["bearer", token]),
});
```

> `defaultHeaders` cannot be attached to a standard `WebSocket`
> handshake in the browser. To pass credentials in a WS environment,
> use the `webSocketFactory` to inject a subprotocol or rely on
> cookie-based auth on the same origin.

## Custom `AgentServerAdapter`

Anything that implements `AgentServerAdapter` can back a
`ThreadStream`:

```ts
interface AgentServerAdapter extends TransportAdapter {
  getState?<S>(): Promise<{ values: S; checkpoint?: { checkpoint_id?: string } | null } | null>;
  getHistory?<S>(options?: { limit?: number }): Promise<Array<{ values: S; checkpoint?: { checkpoint_id?: string } | null }>>;
}

interface TransportAdapter {
  readonly threadId: string;
  open(): Promise<void>;
  send(command: Command): Promise<CommandResponse | ErrorResponse | void>;
  events(): AsyncIterable<Message>;
  openEventStream?(params: SubscribeParams): EventStreamHandle;
  close(): Promise<void>;
}
```

Pass an instance directly:

```ts
import { Client } from "@langchain/langgraph-sdk";

const thread = client.threads.stream({
  assistantId: "agent",
  transport: new MyCustomAdapter({ ... }),
});
```

The `fetch` and `webSocketFactory` options are **ignored** when a
custom adapter is supplied — the adapter is responsible for every
command and subscription.

### `HttpAgentServerAdapter` (batteries included)

For "point at a single HTTP endpoint that speaks the v2 protocol"
deployments, use the provided adapter:

```ts
import { Client, HttpAgentServerAdapter } from "@langchain/langgraph-sdk";

const adapter = new HttpAgentServerAdapter({
  apiUrl: "https://agent.example.com",
  threadId: crypto.randomUUID(),
  defaultHeaders: { "x-tenant": "acme" },
});

const thread = client.threads.stream({
  assistantId: "agent",
  transport: adapter,
});
```

Supply `webSocketFactory` to flip it into WebSocket mode; otherwise
it delegates to the SSE transport internally.

### When to implement `getState` / `getHistory`

Framework packages (`useStream`) call these optional methods to
hydrate state without issuing a parallel REST request:

- `getState()` → one-shot `values` + `checkpoint_id`.
- `getHistory({ limit })` → checkpoint slice for branching / time
  travel UIs.

Omitting them is fine — the framework falls back to the regular
`client.threads.getState` / `getHistory` REST endpoints, and feature
that require them (branching UI, time travel) become no-ops rather
than errors.

## Standalone use with `ThreadStream`

`ThreadStream` accepts any `TransportAdapter` directly — you don't
have to go through `client.threads.stream(...)`:

```ts
import {
  ThreadStream,
  ProtocolSseTransportAdapter,
} from "@langchain/langgraph-sdk";

const transport = new ProtocolSseTransportAdapter({
  apiUrl: "http://localhost:2024",
  threadId: crypto.randomUUID(),
  defaultHeaders: { "x-api-key": process.env.LANGGRAPH_API_KEY ?? "" },
});

const thread = new ThreadStream(transport, { assistantId: "agent" });

await thread.run.start({ input: { messages: [...] } });
for await (const msg of thread.messages) console.log(await msg.text);
await thread.close();
```

This is the escape hatch framework packages use when they need full
control over transport construction. Most applications should prefer
`client.threads.stream(...)` — it wires up headers, auth, and config
for you.

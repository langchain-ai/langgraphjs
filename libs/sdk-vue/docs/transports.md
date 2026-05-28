# Transports

`useStream`'s option bag is a discriminated union on `transport`:

- **LangGraph Platform** — supply `assistantId` (and `apiUrl` or a
  pre-configured `client`). The built-in SSE transport is used by
  default; pass `transport: "websocket"` for the WebSocket variant.
- **Custom backend** — pass `transport: myAdapter` where `myAdapter`
  implements `AgentServerAdapter`, re-exported from `@langchain/vue`.

When using a custom adapter, LGP-specific options such as `client`,
`apiUrl`, `apiKey`, `fetch`, and `webSocketFactory` are compile-time
errors.

## Built-in SSE (default)

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  // transport defaults to "sse"
});
</script>
```

## Built-in WebSocket

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  transport: "websocket",
});
</script>
```

Browsers do not let regular `WebSocket` connections attach arbitrary
custom headers. Use `"sse"` with a `fetch` override when you need
header-based auth:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  transport: "sse",
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-api-key", "my-key");
    return fetch(input, { ...init, headers });
  },
});
</script>
```

## Custom adapter

Bring your own backend by passing an `AgentServerAdapter`
implementation. In most HTTP/SSE cases, use `HttpAgentServerAdapter`,
re-exported from `@langchain/vue`, and implement the Agent Streaming
Protocol endpoints on your server:

```vue
<script setup lang="ts">
import { HttpAgentServerAdapter, useStream } from "@langchain/vue";

const stream = useStream({
  transport: new HttpAgentServerAdapter({
    apiUrl: window.location.origin,
    threadId: "local",
    paths: {
      commands: "/api/threads/local/commands",
      stream: "/api/threads/local/stream",
    },
  }),
  onThreadId: (id) => console.log("Thread created:", id),
});

function onSubmit() {
  void stream.submit({ messages: [{ type: "human", content: "Hello!" }] });
}
</script>

<template>
  <!-- Template expressions auto-unwrap stream refs. -->
  <div v-for="(msg, i) in stream.messages" :key="msg.id ?? i">
    {{ typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }}
  </div>
  <button @click="onSubmit">Send</button>
</template>
```

The [`examples/ui-react-transport`](../../../examples/ui-react-transport)
app uses this shape: the UI uses `HttpAgentServerAdapter`, while the
Hono backend implements `/commands` and `/stream` with a
`LocalThreadSession`.

Subclass `HttpAgentServerAdapter` for header injection / auth /
observability, or implement `AgentServerAdapter` directly for transports
that are not HTTP/SSE shaped.

## Implementing `AgentServerAdapter` from scratch

The [**custom transports**](./custom-transport.md) guide walks through
the contract end-to-end, including a working example, filtering rules,
testing recipes, and common pitfalls. The shape:

```ts
interface AgentServerAdapter {
  readonly threadId: string;
  open(): Promise<void>;
  send(command: Command): Promise<CommandResponse | ErrorResponse | void>;
  events(): AsyncIterable<Message>;
  openEventStream?(params: SubscribeParams): EventStreamHandle;
  close(): Promise<void>;

  // Optional:
  getState?<S = unknown>(): Promise<{
    values: S;
    checkpoint?: { checkpoint_id?: string } | null;
  } | null>;
  getHistory?<S = unknown>(options?: { limit?: number }): Promise<
    Array<{
      values: S;
      checkpoint?: { checkpoint_id?: string } | null;
    }>
  >;
}
```

The LGP client is **not** constructed when a custom adapter is passed,
so bundles that only use a custom adapter tree-shake the entire
built-in SSE / WebSocket stack.

## Related

- [Custom transports](./custom-transport.md) — full
  `AgentServerAdapter` walkthrough, in-memory test stubs, and
  bridging non-LangGraph backends.
- [API reference](./api-reference.md) — `useStream` options and
  return shape.

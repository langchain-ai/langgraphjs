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
implementation. `HttpAgentServerAdapter`, re-exported from
`@langchain/vue`, covers HTTP + SSE + WebSocket out of the box:

```vue
<script setup lang="ts">
import { HttpAgentServerAdapter, useStream } from "@langchain/vue";

const stream = useStream({
  transport: new HttpAgentServerAdapter({
    apiUrl: "https://my-api.example.com/graph",
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

Subclass `HttpAgentServerAdapter` for header injection / auth /
observability, or implement `AgentServerAdapter` directly to proxy
requests through an edge worker.

## Implementing `AgentServerAdapter` from scratch

```ts
interface AgentServerAdapter {
  readonly threadId: string;
  open(): Promise<void>;
  send(command: Command, options: { signal?: AbortSignal }): Promise<void>;
  subscribe(options: {
    onEvent: (event: ProtocolEvent) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;

  // Optional:
  getState?(): Promise<ThreadState>;
  getHistory?(options?: { limit?: number }): Promise<ThreadState[]>;
  openEventStream?(options?): Promise<ReadableStream<Uint8Array>>;
}
```

The LGP client is **not** constructed when a custom adapter is passed,
so bundles that only use a custom adapter tree-shake the entire
built-in SSE / WebSocket stack.

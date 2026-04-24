# Transports

`useStream` supports three transport modes: the default SSE, WebSocket, and custom adapters. The option bag is a discriminated union — picking `transport` selects which branch the hook runs on.

## Table of contents

- [Built-in SSE (default)](#built-in-sse-default)
- [Built-in WebSocket](#built-in-websocket)
- [Header-based auth](#header-based-auth)
- [`HttpAgentServerAdapter`](#httpagentserveradapter)
- [Custom `AgentServerAdapter`](#custom-agentserveradapter)
- [Tree-shaking](#tree-shaking)

## Built-in SSE (default)

```tsx
import { useStream } from "@langchain/react";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  // transport defaults to "sse"
});
```

## Built-in WebSocket

```tsx
const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  transport: "websocket",
});
```

Provide a custom factory if you need to tweak the `WebSocket` instance (for example to attach sub-protocols):

```tsx
const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  transport: "websocket",
  webSocketFactory: (url) => new WebSocket(url, ["custom-protocol"]),
});
```

## Header-based auth

Browsers do not let regular `WebSocket` connections attach arbitrary custom headers. Use `"sse"` + a `fetch` override when you need header-based auth:

```tsx
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
```

## `HttpAgentServerAdapter`

Use `HttpAgentServerAdapter` when you want the v2 transport semantics but against a custom endpoint (for example a Next.js route handler, a self-hosted Python service, or a test stub):

```tsx
import { useStream, HttpAgentServerAdapter } from "@langchain/react";

const transport = new HttpAgentServerAdapter({
  apiUrl: "/api/chat",
  threadId: "thread-123",
  defaultHeaders: { Authorization: `Bearer ${token}` },
  // Optional:
  // fetch: myAuthedFetch,
  // webSocketFactory: (url) => new WebSocket(url),
});

const stream = useStream({ transport });
```

On the custom-adapter branch, `assistantId` is optional (defaults to `"_"`) and server-only options (`apiUrl`, `apiKey`, `fetch`, `webSocketFactory`) are rejected at compile time.

## Custom `AgentServerAdapter`

For full control, implement `AgentServerAdapter` directly:

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

Typical use cases:

- Piping events through an application-specific message bus (Kafka, NATS, Pub/Sub).
- Multiplexing several logical threads over a single physical connection.
- In-memory transports for tests / Storybook stories.

## Tree-shaking

The LGP client is **not** constructed when a custom adapter is passed, so bundles that only use a custom adapter tree-shake the entire built-in SSE / WebSocket stack. This matters if you're embedding `@langchain/react` in a size-sensitive surface like an extension or widget.

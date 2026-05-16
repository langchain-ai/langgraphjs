# Transports

`injectStream`'s option bag is a discriminated union that selects a
wire transport at construction time:

- **LangGraph Platform** — supply `assistantId` (and `apiUrl` or a
  pre-configured `client`). The built-in SSE transport is used by
  default; pass `transport: "websocket"` for the WebSocket variant.
- **Custom backend** — pass `transport: myAdapter` where `myAdapter`
  implements
  [`AgentServerAdapter`](https://github.com/langchain-ai/langgraphjs/blob/main/libs/sdk/src/client/stream/transport.ts)
  from `@langchain/langgraph-sdk`. `HttpAgentServerAdapter` is the
  stock HTTP/SSE implementation.

Passing both `assistantId` and an adapter is a compile-time error.

## LangGraph Platform (SSE — default)

```typescript
readonly stream = injectStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
```

Override `fetch` if you need to add headers or route through an
interceptor:

```typescript
readonly stream = injectStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  fetch: (input, init) => fetch(input, {
    ...init,
    headers: { ...init?.headers, "x-tenant": "acme" },
  }),
});
```

## LangGraph Platform (WebSocket)

```typescript
readonly stream = injectStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  transport: "websocket",
});
```

Supply `webSocketFactory` to customize the underlying `WebSocket`
(e.g. to inject subprotocols or switch to a polyfill in SSR).

## Custom adapter

Bring your own backend by passing an `AgentServerAdapter`
implementation. In most HTTP/SSE cases, use `HttpAgentServerAdapter`
from `@langchain/angular` and implement the Agent Streaming Protocol
endpoints on your server:

```typescript
import { Component } from "@angular/core";
import { HttpAgentServerAdapter, injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div>{{ str(msg.content) }}</div>
    }
    <button (click)="onSubmit()">Send</button>
  `,
})
export class ChatComponent {
  readonly stream = injectStream({
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

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

Subclass `HttpAgentServerAdapter` for header injection / auth /
observability, or implement `AgentServerAdapter` directly for transports
that are not HTTP/SSE shaped. The [**custom transports**](./custom-transport.md)
guide walks through the current `examples/ui-react-transport` setup,
where the UI uses `HttpAgentServerAdapter` and the Hono backend
implements `/commands` and `/stream` with a `LocalThreadSession`.

## Related

- [`injectStream` options](./inject-stream.md#options)
- [Custom transports](./custom-transport.md) — full `AgentServerAdapter`
  walkthrough, in-memory test stubs, and bridging non-LangGraph
  backends.
- [Dependency injection](./dependency-injection.md) — provide a shared
  stream (and therefore a shared transport) to a subtree

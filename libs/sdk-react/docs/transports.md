# Transports

`useStream` talks to an Agent Server over HTTP, with server-sent events for the streams. For a backend that isn't an Agent Server, a custom transport replaces it.

## Table of contents

- [Agent Server](#agent-server)
- [Headers and auth](#headers-and-auth)
- [Custom transports](#custom-transports)
- [Related](#related)

## Agent Server

```tsx
import { useStream } from "@langchain/react";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
```

`transport: "sse"` names the same default.

## Headers and auth

Add fixed headers to every request with `defaultHeaders`:

```tsx
const headers = { "x-tenant-id": "acme" };

function Chat() {
  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    defaultHeaders: headers,
  });
  // ...
}
```

Keep `defaultHeaders` and `callerOptions` the same object across renders, as a constant or with `useMemo`: when one of them changes, the hook builds a new client and a new stream.

For a header that changes, such as a token, pass `fetch`. It is used for every request of the client the hook builds, the latest one each time, so an inline function is fine:

```tsx
const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${await getToken()}`);
    return fetch(input, { ...init, headers });
  },
});
```

With your own `client`, set these on the client instead. `useStream` ignores `fetch` when you pass `client`, and warns once:

```tsx
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: "http://localhost:2024",
  callerOptions: { fetch: authedFetch },
});

const stream = useStream({ assistantId: "agent", client });
```

## Custom transports

For your own backend, pass `transport: { stream(payload) }`. Your server runs the graph and returns the same event stream the Agent Server sends, and the hook's state, messages, interrupts and channels work as with an Agent Server. Thread loads, the server's queue and subagent panels need an Agent Server. See [Custom transports](./custom-transport.md).

## Related

- [Custom transports](./custom-transport.md)
- [`useStream`'s options](./use-stream.md#options)

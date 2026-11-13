# Transports

`useStream` talks to an Agent Server over HTTP, with server-sent events for the streams. For a backend that isn't an Agent Server, a custom transport replaces it.

## Table of contents

- [Agent Server](#agent-server)
- [Headers and auth](#headers-and-auth)
- [Behind a proxy](#behind-a-proxy)
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

## Behind a proxy

A proxy in front of the Agent Server must forward the routes `useStream` calls:

- `GET /info`: what the server supports. Without it, 2.0 acts as on an older server: subagent panels get every event of each run (a warning in the console says so), and tool events and strict answers are off.
- `POST /threads`, `GET /threads/{thread_id}/state` and `POST /threads/{thread_id}/history`: creating and reading threads. History is read for fork points, and for subagent panels after a reload.
- `POST /threads/{thread_id}/runs/stream`: each submit and answer.
- `GET /threads/{thread_id}/runs/{run_id}/stream`: joining a run after a reload, from another tab, or for a subagent panel.
- `POST` and `GET /threads/{thread_id}/runs`, `GET /threads/{thread_id}/runs/{run_id}` and `POST /threads/{thread_id}/runs/{run_id}/cancel`: the server's queue, finding the running run, how a run ended, and `stop()`.
- `GET /threads/{thread_id}/stream`: following runs started elsewhere.

## Custom transports

For your own backend, pass `transport: { stream(payload) }`. Your server runs the graph and returns the same event stream the Agent Server sends, and the hook's state, messages, interrupts and channels work as with an Agent Server. Thread loads, the server's queue and subagent panels need an Agent Server. See [Custom transports](./custom-transport.md).

## Related

- [Custom transports](./custom-transport.md)
- [`useStream`'s options](./use-stream.md#options)

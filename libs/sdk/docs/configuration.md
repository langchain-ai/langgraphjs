# Configuration

The `Client` constructor takes a single `ClientConfig` object. Every
field is optional — a zero-argument `new Client()` is a valid default
for local development against the LangGraph dev server.

```ts
import { Client, type ClientConfig } from "@langchain/langgraph-sdk";

const config: ClientConfig = {
  apiUrl: "https://my-deployment.langgraph.app",
  apiKey: process.env.LANGGRAPH_API_KEY,
  timeoutMs: 60_000,
  defaultHeaders: { "x-tenant": "acme" },
};

const client = new Client(config);
```

## Options

| Option           | Type                                                  | Default                                                           |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `apiUrl`         | `string`                                              | `http://localhost:8123`                                           |
| `apiKey`         | `string \| null`                                      | Auto-loaded from env vars (see below)                             |
| `timeoutMs`      | `number`                                              | No timeout                                                        |
| `defaultHeaders` | `Record<string, string \| null \| undefined>`         | `{}`                                                              |
| `onRequest`      | `(url, init) => RequestInit \| Promise<RequestInit>`  | —                                                                 |
| `streamProtocol` | `"legacy" \| "v2" \| "v2-websocket"`                  | `"legacy"` (only affects the default transport for `threads.stream`) |
| `callerOptions`  | `AsyncCallerParams`                                   | `{ maxRetries: 4, maxConcurrency: 4 }`                            |

### `apiUrl`

Base URL of the LangGraph API server. Trailing slashes are stripped.

For in-process testing — for example when the API server is mounted in
the same process via `@langchain/langgraph-api` — the client can skip
`apiUrl` entirely: a globally installed fetch stub
(`Symbol.for("langgraph_api:fetch")` / `langgraph_api:url`) is picked up
automatically.

### `apiKey`

Authentication key sent as `x-api-key` on every request. Three modes:

| Value       | Behavior                                                                             |
| ----------- | ------------------------------------------------------------------------------------ |
| `string`    | Used verbatim.                                                                       |
| `undefined` | Auto-loads from `LANGGRAPH_API_KEY` → `LANGSMITH_API_KEY` → `LANGCHAIN_API_KEY`.     |
| `null`      | Explicitly disables auto-loading; no `x-api-key` header is sent.                     |

### `defaultHeaders`

Headers applied to every request. `null` and `undefined` values remove
the header instead of setting it — useful for opting out of an
auto-injected default:

```ts
new Client({
  defaultHeaders: {
    "x-tenant": "acme",
    "x-api-key": null, // don't send auto-loaded api key
  },
});
```

The header merger accepts any `HeadersInit` shape (`Headers`, array of
entries, or record).

### `onRequest`

Last-mile hook that receives the resolved `URL` and `RequestInit`
before each HTTP request. Use it for request signing, tracing, or
per-request auth rotation:

```ts
new Client({
  onRequest: async (url, init) => {
    const signed = await signRequest(url, init);
    return { ...init, headers: { ...init.headers, ...signed.headers } };
  },
});
```

The hook applies to plain REST calls **and** to the SSE reconnect path
on `client.threads.stream(...)`. It does not apply to the WebSocket
transport's handshake.

### `streamProtocol`

Opt-in switch for the streaming protocol the SDK uses by default.

| Value             | Effect                                                                           |
| ----------------- | -------------------------------------------------------------------------------- |
| `"legacy"`        | Default. `client.runs.stream(...)` uses the v1 protocol; `threads.stream` still works. |
| `"v2"`            | `client.threads.stream(...)` uses SSE transport (unchanged).                     |
| `"v2-websocket"`  | `client.threads.stream(...)` uses the WebSocket transport by default.            |

The `transport` option passed to `threads.stream()` always wins over
`streamProtocol`. See [Transports](./transports.md).

### `callerOptions`

Forwards directly to the internal `AsyncCaller`:

| Field                 | Description                                         |
| --------------------- | --------------------------------------------------- |
| `maxRetries`          | Retry count for failed REST calls. Default `4`.     |
| `maxConcurrency`      | Max concurrent in-flight requests. Default `4`.     |
| `onFailedResponseHook`| Inspect/transform responses before they throw.      |
| `fetch`               | Inject a `fetch` implementation (Node 16, mocks).   |

### `timeoutMs`

Default per-request timeout. Streaming requests are exempt (they would
abort mid-stream otherwise); `timeoutMs` only applies to unary REST
calls.

## Environment variable precedence

When `apiKey` is `undefined`, the client reads the first non-empty
value from this ordered list:

1. `LANGGRAPH_API_KEY`
2. `LANGSMITH_API_KEY`
3. `LANGCHAIN_API_KEY`

Surrounding quotes are stripped automatically.

## Injecting a custom `fetch`

Two paths:

```ts
new Client({
  callerOptions: { fetch: customFetch },
});
```

applies `customFetch` to every REST call. For the streaming transport
specifically, pass `fetch` through `threads.stream(...)`:

```ts
const thread = client.threads.stream({
  assistantId: "agent",
  fetch: customFetch,
});
```

This is handy for injecting auth proxies, test mocks, or running in
Next.js route handlers where you want to forward cookies.

## Aborting requests

Every method accepts a `signal: AbortSignal`:

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5_000);

await client.threads.search({ signal: ctrl.signal });
```

For streaming, abort the run via `thread.close()`.

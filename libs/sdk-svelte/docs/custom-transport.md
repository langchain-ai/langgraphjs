# Custom Transports

`useStream` can talk to LangGraph Platform directly, or to anything
that implements the Agent Streaming Protocol. The most important
distinction is whether you need a **custom browser transport**, or
just a **custom backend**.

The [`examples/ui-react-transport`](../../../examples/ui-react-transport)
example now demonstrates the recommended custom-backend path:

- The UI uses the stock `HttpAgentServerAdapter`.
- The backend implements the protocol endpoints expected by that
  adapter.
- Custom A2A events are normalized server-side into the protocol's
  `custom:<name>` convention and read with `useExtension`.

The example UI is React, but the transport and server shape are
framework-agnostic. Svelte apps use the same adapter and the same
server contract.

## Choosing A Layer

Use the lightest layer that solves the problem:

- **`"sse"` + `fetch` override**: you are still talking to a
  LangGraph-compatible server and only need headers, auth, or request
  rewriting.
- **`HttpAgentServerAdapter`**: you have your own HTTP server, but it
  can expose `POST /threads/:threadId/commands` and
  `POST /threads/:threadId/stream` semantics.
- **Custom `AgentServerAdapter`**: you are not using that HTTP/SSE
  shape at all, e.g. WebTransport, `postMessage`, in-memory fixtures,
  a multiplexed socket, or an application-specific event bus.

Most production custom backends should start with
`HttpAgentServerAdapter`.

## Client Setup In Svelte

Create the adapter once and pass it to `useStream` or `provideStream`.
Use `paths` when your server routes live under an app-specific prefix,
as in the example.

```svelte
<script lang="ts">
  import { HttpAgentServerAdapter, provideStream } from "@langchain/svelte";
  import type { GraphType } from "./app";

  const threadId = "local";
  const transport = new HttpAgentServerAdapter({
    apiUrl: window.location.origin,
    threadId,
    paths: {
      commands: `/api/threads/${threadId}/commands`,
      stream: `/api/threads/${threadId}/stream`,
    },
  });

  provideStream<GraphType>({ transport });
</script>

<Chat />
<A2AProjectionPanel />
<Prompt />
```

For a single component, call `useStream` directly:

```svelte
<script lang="ts">
  import { HttpAgentServerAdapter, useStream } from "@langchain/svelte";

  const threadId = "local";
  const stream = useStream({
    transport: new HttpAgentServerAdapter({
      apiUrl: window.location.origin,
      threadId,
      paths: {
        commands: `/api/threads/${threadId}/commands`,
        stream: `/api/threads/${threadId}/stream`,
      },
    }),
  });
</script>
```

Construct the adapter at component initialization time. Recreating it
inside a hot `$effect` closes the old stream and opens a new one.

## Updated Example Architecture

On the server, `CustomGraphServer` owns a `LocalThreadSession` per
thread and exposes the two protocol endpoints:

```ts
this.#app.post(
  "/api/threads/:threadId/commands",
  this.#commands.bind(this)
);
this.#app.post("/api/threads/:threadId/stream", this.#stream.bind(this));
```

`POST /commands` receives protocol `Command` objects and returns a
`CommandResponse` or `ErrorResponse`. `POST /stream` receives
`SubscribeParams` and returns a filtered SSE stream.

```ts
async #commands(ctx: Context) {
  const threadId = ctx.req.param("threadId") ?? "local";
  const command = (await ctx.req.json()) as Command;
  return ctx.json(await this.#session(threadId).handleCommand(command));
}

async #stream(ctx: Context) {
  const threadId = ctx.req.param("threadId") ?? "local";
  const params = (await ctx.req.json()) as SubscribeParams;

  return new Response(this.#session(threadId).stream(params), {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  });
}
```

In a SvelteKit app, the same shape maps to `+server.ts` handlers that
read the command or subscription body and delegate to your session
layer.

## Server-Side Session

`LocalThreadSession` is the server-side counterpart to
`HttpAgentServerAdapter`. It implements the HTTP/SSE model of the
Agent Streaming Protocol:

- `handleCommand(command)` handles `run.start`, starts an in-process
  LangGraph run with `graph.streamEvents(input, { version: "v3" })`,
  and immediately returns a success response with a `run_id`.
- `stream(params)` opens a connection-scoped SSE subscription, first
  replaying buffered events that match `params`, then staying attached
  for live events.
- `#publish(event)` stores each event in memory, encodes it as an SSE
  frame, and sends it to every active subscription whose filters match.

The example stores sessions and replay buffers in memory because it is
a local demo. A production server should persist thread state, enforce
concurrency policy, and coordinate replay buffers across workers.

## Commands

For the SSE/HTTP transport, commands are normal JSON request/response
messages. The example supports `run.start`:

```ts
async handleCommand(command: Command): Promise<CommandResponse | ErrorResponse> {
  if (command.method !== "run.start") {
    return {
      type: "error",
      id: command.id,
      error: "unknown_command",
      message: `Unsupported command: ${command.method}`,
    };
  }

  const params = isRecord(command.params)
    ? (command.params as { input?: unknown })
    : {};
  void this.#startRun(params.input);

  return {
    type: "success",
    id: command.id,
    result: { run_id: crypto.randomUUID() },
  };
}
```

For a richer backend, this is where you would also handle interrupt
resume commands, state commands, cancellation, auth checks, or
application-specific validation.

## Streaming And Replay

Each call to `/stream` is an independent SSE connection. The request
body is `SubscribeParams`:

```ts
type SubscribeParams = {
  channels: Array<
    | "values"
    | "messages"
    | "updates"
    | "checkpoints"
    | "tasks"
    | "tools"
    | "custom"
    | "lifecycle"
    | "input.requested"
    | `custom:${string}`
  >;
  namespaces?: Array<string[]>;
  depth?: number;
  since?: number;
};
```

The example keeps an in-memory event buffer. When a new stream opens,
it replays buffered events newer than `since` and matching the
requested channels, namespaces, and depth. This lets selector
subscriptions mount after a run has already started without forcing
the graph to restart.

## Filtering Rules

The server must apply the same filtering model that the client asks
for:

- `channels` selects event concerns: `messages`, `values`, `tools`,
  `lifecycle`, `tasks`, `custom`, or named custom channels like
  `custom:a2a`.
- `namespaces` is a list of namespace prefixes. `[]` means the root
  graph; child arrays target subgraphs or nested agents.
- `depth` limits how far below a matched namespace prefix events are
  delivered.
- `since` replays only events after the last sequence number the
  client observed.

The example's `segmentMatches` helper also handles LangGraph namespace
segments with dynamic suffixes. A filter for `"agent"` matches emitted
segments like `"agent:run-uuid"`, while a filter containing `:`
requires an exact match.

## Custom Event Normalization

The example graph installs an A2A stream transformer:

```ts
this.#graph = graph.withConfig({
  streamTransformers: [createA2ATransformer],
});
```

`StreamChannel.remote("a2a")` emits remote extension events with a
non-standard event method such as `"a2a"`. The Agent Streaming
Protocol reserves `method: "custom"` for extensions, so the server
normalizes non-protocol methods into the custom envelope:

```ts
function normalizeEvent(event: ProtocolEvent): ProtocolEvent {
  if (PROTOCOL_METHODS.has(event.method)) return event;

  return {
    ...event,
    method: "custom",
    params: {
      ...event.params,
      data: {
        name: event.method,
        payload: event.params.data,
      },
    },
  } as ProtocolEvent;
}
```

After normalization, `useExtension(stream, "a2a")` subscribes to
`custom:a2a` and receives `params.data.payload`.

```svelte
<script lang="ts">
  import { getStream, useExtension } from "@langchain/svelte";

  const stream = getStream<GraphType>();
  const a2a = useExtension<A2AStreamEvent>(stream, "a2a");
  let events = $state<A2AStreamEvent[]>([]);

  $effect(() => {
    const payload = a2a.current;
    if (payload != null) events = [...events, payload];
  });
</script>
```

The component does not care whether events came from LangGraph
Platform or this local protocol server.

## SSE Encoding

`HttpAgentServerAdapter` expects SSE frames whose `data:` field is a
JSON Agent Protocol message. The example also mirrors `event_id` or
`seq` into the SSE `id:` field:

```ts
function encodeSse(event: ProtocolEvent) {
  const eventId = (event as { event_id?: string }).event_id;
  const id = eventId ?? (typeof event.seq === "number" ? `${event.seq}` : "");
  const idLine = id ? `id: ${id}\n` : "";
  return new TextEncoder().encode(
    `${idLine}event: message\ndata: ${JSON.stringify(event)}\n\n`
  );
}
```

Keep the event object intact in `data:`. Do not split protocol fields
between SSE `event:` names and JSON payloads unless you also provide a
custom browser adapter that knows how to reverse that transformation.

## `HttpAgentServerAdapter` Options

Use `paths` when your backend routes do not live at the default
`/threads/:threadId/...` paths:

```ts
const transport = new HttpAgentServerAdapter({
  apiUrl: window.location.origin,
  threadId: "local",
  paths: {
    commands: "/api/threads/local/commands",
    stream: "/api/threads/local/stream",
  },
});
```

Other useful options:

```ts
const transport = new HttpAgentServerAdapter({
  apiUrl: "/agent",
  threadId,
  defaultHeaders: { Authorization: `Bearer ${token}` },
  onRequest: async (url, init) => ({
    ...init,
    headers: { ...init.headers, "x-trace-id": crypto.randomUUID() },
  }),
  fetch: myFetch,
});
```

Passing `webSocketFactory` switches the adapter to the WebSocket
delegate and uses the stream path as the socket endpoint.

## When To Implement `AgentServerAdapter` Directly

Implement the adapter interface yourself only when the stock HTTP/SSE
adapter cannot describe your transport.

```ts
interface AgentServerAdapter {
  readonly threadId: string;
  open(): Promise<void>;
  close(): Promise<void>;
  send(command: Command): Promise<CommandResponse | ErrorResponse | void>;
  events(): AsyncIterable<Message>;
  openEventStream?(params: SubscribeParams): EventStreamHandle;
  getState?<S = unknown>(): Promise<{
    values: S;
    checkpoint?: { checkpoint_id?: string } | null;
  } | null>;
}
```

Direct adapters are useful for in-memory tests, browser-native
transports, a shared socket that multiplexes many logical threads, or
an application bus that is not HTTP/SSE shaped.

If your backend can expose command and stream endpoints, prefer
`HttpAgentServerAdapter` plus server-side protocol handling.

## Common Pitfalls

- **Putting custom parsing in the browser when the backend can emit
  protocol SSE.** Prefer normalizing server-side and keep the client
  on `HttpAgentServerAdapter`.
- **Forgetting replay.** Selector subscriptions can be opened after a
  run has started. Buffer events and honor `since` so late subscribers
  catch up.
- **Dropping namespace filters.** Subagent and subgraph selectors rely
  on `namespaces` and `depth` being applied server-side.
- **Using `custom` instead of `custom:<name>`.** `custom` receives all
  custom events; `useExtension(stream, "a2a")` subscribes to
  `custom:a2a`.
- **Recreating the adapter in reactive code.** Construct at script
  initialization time or inside an explicitly keyed lifecycle path.
- **Treating the example session as production persistence.**
  `LocalThreadSession` is process-local and in-memory by design.

## Related

- [`useStream`](./use-stream.md)
- [Selector composables and `useExtension`](./selector-composables.md)
- [Stream context](./stream-context.md)
- [`examples/ui-react-transport`](../../../examples/ui-react-transport)

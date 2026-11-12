# Custom transports

`useStream` normally talks to an Agent Server. With a custom transport it talks to your own backend instead: your server runs the graph and returns the event stream an Agent Server would send.

## Table of contents

- [When to use one](#when-to-use-one)
- [The client](#the-client)
- [The server](#the-server)
- [The stream](#the-stream)
- [What needs an Agent Server](#what-needs-an-agent-server)
- [Writing your own transport](#writing-your-own-transport)
- [Related](#related)

## When to use one

- **Your backend is an Agent Server**, also behind a proxy: you don't need one. Use `apiUrl`, and `defaultHeaders` or `fetch` for auth (see [Transports](./transports.md)).
- **Your backend runs the graph itself**, in a route of your own server: use a custom transport.

## The client

`FetchStreamTransport` from the SDK posts each run to one endpoint and reads the stream it answers with:

```tsx
import { FetchStreamTransport } from "@langchain/langgraph-sdk/ui";
import { useStream } from "@langchain/react";

const transport = new FetchStreamTransport({ apiUrl: "/api/stream" });

function Chat() {
  const stream = useStream({ transport });
  // stream.messages, stream.submit, stream.interrupts and the rest, as usual
}
```

- Create the transport once, outside the component or with `useMemo`: a new transport builds a new stream.
- `assistantId` is optional, since your server picks the graph.
- `FetchStreamTransport` also takes `defaultHeaders`, `fetch`, and `onRequest(url, init)` to change each request before it is sent.
- `StreamProvider` takes a `transport` too.

## The server

Each run is a `POST` with a JSON body:

- `input`: the submit's input, or `null` for an answer to an interrupt.
- `command`: the answer to an interrupt, as `{ resume: { [interruptId]: value }, update?, goto? }`, or a submit's `command`.
- `config`: the run's config, with `configurable.thread_id` set. For a new conversation, the browser makes that id and reports it with `onThreadId`.

A server on LangGraph JS can return the graph's stream as it is:

```ts
import { Command } from "@langchain/langgraph";
import { graph } from "./graph"; // compiled with a checkpointer

export async function POST(request: Request): Promise<Response> {
  const { input, command, config } = await request.json();
  const stream = await graph.stream(
    command != null ? new Command(command) : input,
    {
      ...config,
      streamMode: ["values", "messages", "updates", "custom"],
      encoding: "text/event-stream",
      signal: request.signal,
    }
  );
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

`request.signal` stops the run when the browser calls `stop()`. The checkpointer keeps each thread's state between requests, under `config.configurable.thread_id`.

## The stream

The response is server-sent events, the format of the Agent Server's run streams: each event's name is a stream mode, and its data is JSON.

| Event      | Data                                                                    | Shows as                                                   |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `values`   | The state after each step. An interrupt arrives as `{ __interrupt__ }`. | `values`, `messages`, `toolCalls`, `interrupts`            |
| `messages` | `[chunk, metadata]`: a message chunk as the model streams it.           | Token-by-token `messages`                                  |
| `updates`  | What each node returned.                                                | The `updates` channel                                      |
| `custom`   | What the graph wrote with its stream writer.                            | The `custom` channel                                       |
| `error`    | `{ error, message }`                                                    | `error`, and the run ends                                  |

Events from a subgraph carry its namespace after the mode, as in `values|node:1234`.

## What needs an Agent Server

A custom transport streams runs, and nothing else, so:

- **Loading a thread:** a conversation shows only what this page streamed. `hydrate()` rejects, and `isThreadLoading` stays `false`.
- **The queue:** a submit made during a run waits in the page and starts when the run ends. `useSubmissionQueue` lists it, and `cancel` and `clear` drop it. A thread switch or `stop()` drops it too.
- **Answers:** `respond` and `respondAll` send the answer through your transport, as a run with a `command`.
- **Subagent panels:** `useMessages(stream, subagent)` and the other selector hooks return nothing for a target.
- **Fork points:** `useMessageMetadata` has no `parentCheckpointId`.

## Writing your own transport

A transport is any object with a `stream(payload)` method, for a backend that isn't one HTTP endpoint (WebSockets, `postMessage`, tests):

```ts
const transport = {
  async stream(payload: {
    input: unknown;
    command: unknown;
    config: unknown;
    signal: AbortSignal;
  }) {
    // Send the run, and return an async iterable of events:
    // { event: "values", data: { messages: [...] } }, ...
    return runSomewhere(payload);
  },
};
```

`stream` returns a promise of an async iterable of `{ id?, event, data }` objects, with the events above. Stop when `payload.signal` aborts.

## Related

- [Transports](./transports.md)
- [`useStream`'s options](./use-stream.md#options)
- [`StreamProvider`](./context.md)

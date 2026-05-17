# `client.runs` (legacy)

> **Deprecation notice.** The streaming-oriented methods on
> `client.runs` (`stream`, `joinStream`, `wait` for streaming-style
> consumption) use the **v1 streaming protocol** and are kept for
> backwards compatibility only. New code should consume streams via
> [`client.threads.stream(...)`](./streaming.md) — it provides typed
> projections, deduplication, automatic reconnect, interrupt handling,
> and end-to-end type safety that the v1 generators do not.
>
> The non-streaming CRUD methods (`create`, `createBatch`, `wait`,
> `list`, `get`, `cancel`, `cancelMany`, `join`, `delete`) remain the
> canonical way to trigger runs without streaming — for webhooks,
> batch jobs, and background workers.

## Why the change?

The v1 streaming generators (`client.runs.stream`,
`client.threads.joinStream`, `client.runs.joinStream`) emit protocol
events as plain tagged tuples:

```ts
for await (const event of client.runs.stream(threadId, assistantId, { ... })) {
  if (event.event === "values") { ... }
  if (event.event === "messages/partial") { ... }
  if (event.event === "updates") { ... }
  // ... plus about a dozen more `stream_mode`s
}
```

You end up re-implementing the same pattern in every app: an ad-hoc
switch across `stream_mode` strings, manual message assembly, manual
interrupt capture, manual reconnect with `lastEventId`, and manual
subgraph / subagent tracking.

The v2 primitive does all of that for you and is the same shape as the
in-process `graph.streamEvents(..., { version: "v3" })` API:

```ts
const thread = client.threads.stream({ assistantId: "my-agent" });
await thread.run.start({ input: { ... } });

for await (const msg of thread.messages) {
  for await (const token of msg.text) { ... }
}
console.log(await thread.output);
```

See [Streaming](./streaming.md) for the full guide.

## Migration

| v1 call                                             | v2 replacement                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `client.runs.stream(threadId, assistantId, p)`      | `const t = client.threads.stream(threadId, { assistantId }); await t.run.start(p)`       |
| `client.runs.stream(null, assistantId, p)`          | `const t = client.threads.stream({ assistantId }); await t.run.start(p)`                 |
| `client.runs.joinStream(threadId, runId, o)`        | `const t = client.threads.stream(threadId, { assistantId }); ...` *(re-attach)*          |
| `client.threads.joinStream(threadId, o)`            | `const t = client.threads.stream(threadId, { assistantId }); ...` *(re-attach)*          |
| Per-`stream_mode` branching                         | `thread.messages` / `thread.values` / `thread.toolCalls` / `thread.extensions.<name>`    |
| Manual interrupt capture via `values` events        | `thread.interrupted` / `thread.interrupts` / `thread.input.respond(...)`                 |

## Non-streaming CRUD (still current)

The non-streaming methods are untouched by the deprecation and remain
the canonical way to trigger runs outside of a live connection.

### `create(threadId, assistantId, payload?)`

Enqueue a run without streaming. Returns a `Run` record.

```ts
const run = await client.runs.create(threadId, assistantId, {
  input: { messages: [...] },
  webhook: "https://example.com/hook",
  onRunCreated: ({ run_id, thread_id }) => console.log(run_id),
});
```

`threadId` can be `null` for stateless "one-off" runs.

### `createBatch(payloads, options?)`

Create many runs in one request:

```ts
await client.runs.createBatch([
  { assistantId: "agent", input: { ... } },
  { assistantId: "agent", input: { ... } },
]);
```

### `wait(threadId, assistantId, payload?)`

Create a run and block until it finishes. Returns the final state
values. Behaves like a POST + join:

```ts
const finalState = await client.runs.wait(threadId, assistantId, {
  input: { messages: [...] },
  raiseError: true,
});
```

Useful for scripts / one-shot invocations where you want the answer
but don't care about streaming.

### `list(threadId, options?)`

```ts
await client.runs.list(threadId, {
  limit: 20,
  offset: 0,
  status: "success",
  select: ["run_id", "status", "created_at"],
});
```

### `get(threadId, runId, options?)`

Fetch a run record.

### `cancel(threadId, runId, wait?, action?)`

```ts
await client.runs.cancel(threadId, runId, true, "interrupt");
await client.runs.cancel(threadId, runId, false, "rollback");
```

| `action`       | Effect                                                              |
| -------------- | ------------------------------------------------------------------- |
| `"interrupt"`  | Stop after the current super-step (default).                        |
| `"rollback"`   | Roll back to the last checkpoint and stop.                          |

### `cancelMany(options)`

Batch cancel:

```ts
await client.runs.cancelMany({
  threadId,
  status: "running",
  action: "interrupt",
});
```

### `join(threadId, runId, options?)`

Block (without streaming) until a specific run finishes; returns its
state values.

```ts
const state = await client.runs.join(threadId, runId, {
  cancelOnDisconnect: true,
});
```

### `delete(threadId, runId)`

Delete a run record.

## Still need the v1 stream?

If you're integrating with an environment that can't use the v2
primitive yet (for example a bridged backend that only understands
the v1 SSE format), `client.runs.stream(...)` and
`client.threads.joinStream(...)` continue to work unchanged. New
features such as typed subagents, subgraph cause metadata, media handles,
and custom-transformer extensions are **only available via
`client.threads.stream(...)`** — there are no plans to port them back
to the v1 generators.

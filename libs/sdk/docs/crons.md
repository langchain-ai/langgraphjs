# `client.crons`

Cron jobs let you schedule recurring or future-dated runs against an
assistant. They execute on the LangGraph server on a cron-style
schedule you specify, and drive the same run machinery you'd trigger
from a live client — with optional webhook delivery when each run
finishes.

```ts
const { cron_id } = await client.crons.create("my-agent", {
  schedule: "0 9 * * *",
  timezone: "America/Los_Angeles",
  input: { messages: [{ role: "user", content: "Daily briefing" }] },
  webhook: "https://example.com/webhooks/briefing",
});
```

> Streaming cron output is **not** part of the recommended streaming
> path. Cron jobs run server-side and deliver results via
> `webhook` / `on_run_completed`. The `streamMode`, `streamSubgraphs`,
> and `streamResumable` options on cron payloads are preserved for
> backwards compatibility with the v1 streaming protocol — new code
> that wants to observe a cron-triggered run live should fetch the
> produced `run_id` and attach with
> [`client.threads.stream(threadId, { assistantId })`](./streaming.md).

## Create a cron

Two variants: one scoped to an existing thread, one that creates a
fresh thread each time it fires.

### `create(assistantId, payload?)`

Create a cron that spawns a new thread per execution.

```ts
const { cron_id } = await client.crons.create("my-agent", {
  schedule: "*/15 * * * *",
  input: { messages: [{ role: "user", content: "tick" }] },
  timezone: "UTC",
  enabled: true,
  endTime: "2026-12-31T00:00:00Z",
  onRunCompleted: "delete",
});
```

### `createForThread(threadId, assistantId, payload?)`

Create a cron that always runs against the same thread — useful for
reminders that accrue context over time.

```ts
await client.crons.createForThread(threadId, "my-agent", {
  schedule: "0 * * * *",
  input: { messages: [{ role: "user", content: "hourly check-in" }] },
});
```

### Payload reference

| Field              | Description                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| `schedule`         | Cron expression (5 or 6 fields).                                              |
| `timezone`         | IANA time zone (`"America/Los_Angeles"`, etc). Defaults to `"UTC"`.           |
| `input`            | Initial graph input for each execution.                                       |
| `config`           | Runnable config (`tags`, `recursion_limit`, `configurable`, ...).             |
| `context`          | Per-run context injected into the graph.                                      |
| `metadata`         | Free-form metadata stored on each resulting run.                              |
| `webhook`          | URL invoked when a scheduled run finishes.                                    |
| `interruptBefore`  | Node names to pause before.                                                   |
| `interruptAfter`   | Node names to pause after.                                                    |
| `multitaskStrategy`| `"reject" \| "rollback" \| "interrupt" \| "enqueue"`.                          |
| `checkpointDuring` | Persist checkpoints while the run executes.                                   |
| `durability`       | Durability level of checkpoints (`"exit" \| "async" \| "sync"`).              |
| `enabled`          | If `false`, the cron is created but will not fire until re-enabled.           |
| `endTime`          | ISO timestamp after which the cron is no longer fired.                        |
| `onRunCompleted`   | `"delete"` to drop each run's record on completion, or `undefined` to retain. |

## Update

### `update(cronId, payload?)`

Patch any subset of the fields above:

```ts
await client.crons.update(cronId, {
  schedule: "0 9 * * 1-5",
  timezone: "Europe/Berlin",
  enabled: false,
});
```

## Delete

### `delete(cronId)`

```ts
await client.crons.delete(cronId);
```

## Search & count

### `search(query?)`

```ts
const crons = await client.crons.search({
  assistantId: "my-agent",
  enabled: true,
  limit: 20,
  sortBy: "next_run_date",
  sortOrder: "asc",
});
```

| Field         | Description                                                         |
| ------------- | ------------------------------------------------------------------- |
| `assistantId` | Only crons tied to this assistant.                                  |
| `threadId`    | Only crons created with `createForThread`.                          |
| `enabled`     | Filter by `enabled` state.                                          |
| `limit`       | Page size (default `10`).                                           |
| `offset`      | Page offset (default `0`).                                          |
| `sortBy`      | `"cron_id" \| "created_at" \| "updated_at" \| "next_run_date"`.     |
| `sortOrder`   | `"asc" \| "desc"`.                                                  |
| `select`      | Subset of fields to return.                                         |

### `count(query?)`

```ts
const total = await client.crons.count({ assistantId: "my-agent" });
```

## Observing a cron run live

A cron invocation produces a normal run on a thread. To watch one as
it happens:

1. Receive the `thread_id` / `run_id` from your `webhook` or by
   polling `client.runs.list(threadId)`.
2. Attach a `ThreadStream`:

```ts
const thread = client.threads.stream(threadId, { assistantId: "my-agent" });
for await (const msg of thread.messages) {
  for await (const token of msg.text) {
    process.stdout.write(token);
  }
}
```

See [Streaming](./streaming.md) for the full primitive.

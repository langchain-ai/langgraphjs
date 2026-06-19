# `client.threads`

A **thread** is the durable carrier of an agent's state, backed by
checkpoints. Most runs operate on a thread — either creating one
implicitly (via `client.threads.stream(...)`) or attaching to an
existing thread id.

This guide covers the non-streaming CRUD, state, and history APIs.
For **streaming**, see [Streaming](./streaming.md) — it's the
recommended API for any real-time consumption.

## Quick reference

| Method                                                    | Purpose                                       |
| --------------------------------------------------------- | --------------------------------------------- |
| [`create(payload?)`](#createpayload)                      | Create a thread.                              |
| [`get(threadId)`](#getthreadid)                           | Fetch a thread record.                        |
| [`copy(threadId)`](#copythreadid)                         | Duplicate an existing thread.                 |
| [`update(threadId, payload?)`](#updatethreadid-payload)   | Patch metadata or TTL.                        |
| [`delete(threadId)`](#deletethreadid)                     | Delete a thread.                              |
| [`prune(threadIds, options?)`](#prunethreadids-options)   | Bulk cleanup / checkpoint pruning.            |
| [`search(query?)`](#searchquery)                          | List / filter threads.                        |
| [`count(query?)`](#countquery)                            | Count matching threads.                       |
| [`getState(threadId, checkpoint?)`](#getstate)            | Current or checkpoint state.                  |
| [`updateState(threadId, options)`](#updatestate)          | Write new state (also creates a checkpoint).  |
| [`patchState(threadIdOrConfig, metadata)`](#patchstate)   | Patch state metadata.                         |
| [`getHistory(threadId, options?)`](#history)              | List past checkpoints.                        |
| [`stream(threadId?, options)`](./streaming.md)            | Open a `ThreadStream` (recommended).          |
| [`joinStream(threadId, options?)`](#joinstream-legacy)    | Legacy. Replay an in-flight v1 run.           |

## CRUD

### `create(payload?)`

```ts
const thread = await client.threads.create({
  metadata: { topic: "support" },
  graphId: "chat-agent",
  threadId: crypto.randomUUID(), // optional
  ifExists: "do_nothing",        // "raise" | "do_nothing"
  ttl: 3600,                     // seconds, or { ttl, strategy: "delete" }
});
```

| Option       | Type                                                  | Description                                                          |
| ------------ | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `metadata`   | `Record<string, unknown>`                             | Free-form tags. Filterable via `search`.                             |
| `graphId`    | `string`                                              | Shorthand for `metadata.graph_id`.                                   |
| `threadId`   | `string`                                              | Explicit id. Defaults to a server-generated UUID.                    |
| `ifExists`   | `"raise" \| "do_nothing"`                             | Behavior when `threadId` is already taken.                           |
| `supersteps` | `Array<{ updates: [{ values, command?, asNode }] }>`  | Pre-populate with initial checkpoints (power-user).                  |
| `ttl`        | `number \| { ttl, strategy?: "delete" }`              | Expiry TTL. Number is shorthand for `{ ttl, strategy: "delete" }`.   |

### `get(threadId)`

```ts
const thread = await client.threads.get(threadId, {
  include: ["values", "checkpoint_id"],
});
```

`include` limits which top-level fields the server returns — useful
when paginating large lists.

### `copy(threadId)`

Deep-copies an existing thread, including checkpoint history. Returns
the new thread record.

### `update(threadId, payload?)`

```ts
await client.threads.update(threadId, {
  metadata: { topic: "resolved" },
  ttl: 600,
});
```

### `delete(threadId)`

Hard-deletes the thread and its checkpoints.

### `prune(threadIds, options?)`

Bulk operation. Two strategies:

```ts
await client.threads.prune(["id1", "id2"], { strategy: "delete" });
await client.threads.prune(["id1", "id2"], { strategy: "keep_latest" });
```

| Strategy        | Effect                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `"delete"`      | Remove the threads entirely (default).                                     |
| `"keep_latest"` | Keep the thread record and its latest state; drop older checkpoints.       |

Returns `{ pruned_count: number }`.

### `search(query?)`

```ts
const threads = await client.threads.search({
  metadata: { topic: "support" },
  status: "idle",
  limit: 50,
  offset: 0,
  sortBy: "updated_at",
  sortOrder: "desc",
  values: { user_id: "abc" },
  extract: { topicPath: "$.metadata.topic" },
});
```

| Option       | Type                                    | Description                                                                          |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `metadata`   | `Record<string, unknown>`               | Equality filter.                                                                     |
| `ids`        | `string[]`                              | Subset by id.                                                                        |
| `status`     | `"idle" \| "busy" \| "interrupted" \| "error"` | Execution state.                                                                     |
| `values`     | `ThreadValuesFilter`                    | State-value predicate (provider-specific).                                           |
| `sortBy`     | `ThreadSortBy`                          | `"created_at"` / `"updated_at"`.                                                     |
| `select`     | `ThreadSelectField[]`                   | Limit returned fields.                                                               |
| `extract`    | `Record<string, string>`                | Server-side projection using JSONPath expressions; keyed results appear on each row. |

### `count(query?)`

```ts
const n = await client.threads.count({ status: "interrupted" });
```

## State and history

### `getState`

```ts
// Latest state.
await client.threads.getState<MyState>(threadId);

// At a specific checkpoint.
await client.threads.getState<MyState>(threadId, {
  thread_id: threadId,
  checkpoint_id: "0195…",
  checkpoint_ns: "",
});

// Legacy: by raw checkpoint id string.
await client.threads.getState<MyState>(threadId, "0195…");

// Include every nested subgraph's state.
await client.threads.getState<MyState>(threadId, undefined, { subgraphs: true });
```

### `updateState`

```ts
await client.threads.updateState<MyUpdate>(threadId, {
  values: { draft: "new body" },
  asNode: "human_review",
});
```

Creates a new checkpoint. When `checkpoint` / `checkpointId` is
supplied, the update is applied on top of that historical checkpoint
(branch).

### `patchState`

```ts
await client.threads.patchState(threadId, { tag: "reviewed" });
```

Or use a `Config` object:

```ts
await client.threads.patchState(
  { configurable: { thread_id: threadId } },
  { tag: "reviewed" }
);
```

Patches only the state's **metadata** without creating a new
checkpoint.

### History

```ts
const history = await client.threads.getHistory<MyState>(threadId, {
  limit: 20,
  before: { configurable: { thread_id: threadId, checkpoint_id: "…" } },
  checkpoint: { checkpoint_ns: "researcher" }, // nested checkpoints
  metadata: { source: "user" },
});
```

Each entry is a `ThreadState` with `values`, `next`, `tasks`,
`checkpoint`, `parent_checkpoint`, `metadata`, `created_at`.

## `joinStream` (legacy)

`client.threads.joinStream(threadId, options?)` re-attaches to an
in-flight v1 run and replays its event stream:

```ts
for await (const event of client.threads.joinStream(threadId, {
  lastEventId: "123",
  streamMode: ["messages", "values"],
})) {
  console.log(event.event, event.data);
}
```

> **Deprecated for new code.** For all new streaming work, use
> [`client.threads.stream(...)`](./streaming.md). The v2 primitive
> has built-in re-attach semantics (just pass the existing `threadId`),
> dedup, backfill, and typed projections.

## `stream(...)`

See the full guide at [Streaming](./streaming.md).

```ts
// New thread.
const thread = client.threads.stream({ assistantId: "agent" });

// Attach to an existing thread.
const attached = client.threads.stream(threadId, { assistantId: "agent" });
```

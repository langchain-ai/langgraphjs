# `client.assistants`

An **assistant** is a named, versioned binding of a compiled graph
(`graph_id`) plus a default config / context. Every run is launched
against an assistant. The LangGraph dev server auto-creates one
assistant per graph registered in `langgraph.json`, so in development
you rarely construct them by hand — but versioning, promotion, and
multi-tenant deployments rely on the full CRUD surface.

```ts
const assistants = await client.assistants.search({ limit: 10 });
```

## Methods

### `get(assistantId, options?)`

```ts
await client.assistants.get("my-agent");
```

Returns the `Assistant` record.

### `getGraph(assistantId, options?)`

JSON representation of the graph (nodes, edges, channels).

```ts
await client.assistants.getGraph("my-agent", { xray: 2 });
```

`options.xray` includes subgraphs up to a given depth (`true` = all).

### `getSchemas(assistantId, options?)`

Returns the state schema and config schema for the assistant's graph.

### `getSubgraphs(assistantId, options?)`

Enumerate subgraphs at a specific namespace.

```ts
const subs = await client.assistants.getSubgraphs("my-agent", {
  namespace: "researcher",
  recurse: true,
});
```

### `create(payload)`

```ts
const assistant = await client.assistants.create({
  graphId: "chat-agent",
  name: "Production chat",
  metadata: { env: "prod" },
  config: { configurable: { ... } },
  context: { ... },
  ifExists: "do_nothing", // "raise" | "do_nothing"
});
```

### `update(assistantId, payload)`

Patches metadata, config, context, or name. Creates a new version —
see `getVersions` / `setLatest` to inspect and promote versions.

```ts
await client.assistants.update("my-agent", {
  name: "Production chat v2",
  config: { configurable: { temperature: 0.2 } },
});
```

### `delete(assistantId, options?)`

Delete an assistant. Does not delete threads tied to it.

### `search(query?)`

```ts
const results = await client.assistants.search({
  graphId: "chat-agent",
  metadata: { env: "prod" },
  limit: 25,
  offset: 0,
  sortBy: "updated_at",
  sortOrder: "desc",
  select: ["assistant_id", "name", "metadata"],
});
```

| Option          | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `graphId`       | Filter by graph.                                              |
| `metadata`      | Partial metadata match (exact equality on each supplied key). |
| `limit`         | Page size. Default `10`.                                      |
| `offset`        | Page offset. Default `0`.                                     |
| `sortBy`        | `"created_at"` \| `"updated_at"` \| `"name"`.                 |
| `sortOrder`     | `"asc"` \| `"desc"`.                                          |
| `select`        | Limit the returned fields — smaller payloads for lists.       |

There's an overload that returns a paginated `AssistantsSearchResponse`
when you pass `paginated: true`; see the TS types for specifics.

### `count(query?)`

Returns the number of assistants matching the filter.

### `getVersions(assistantId, options?)`

Lists version history.

### `setLatest(assistantId, version)`

Promotes a specific version to "latest" — runs launched with the
assistant id (no explicit version) then target that version.

## See also

- [Runs (legacy)](./runs.md) — how to launch and manage runs on an
  assistant outside the streaming path.
- [Threads](./threads.md) — threads are the durable carrier of an
  assistant's state.

# `client.store`

A namespaced key-value store that lives alongside your graph. Good
for long-term memory, user preferences, semantic caches, and any
cross-thread data your agent needs to recall.

```ts
await client.store.putItem(["users", userId, "profile"], "preferences", {
  theme: "dark",
  language: "en",
});

const item = await client.store.getItem(
  ["users", userId, "profile"],
  "preferences"
);
```

Items are identified by a `(namespace, key)` pair. Namespaces are
arrays of strings (no dots allowed — the server uses `.` as a
delimiter internally).

## Items

### `putItem(namespace, key, value, options?)`

Create or overwrite an item.

```ts
await client.store.putItem(
  ["users", userId, "memories"],
  "favorite-food",
  { value: "pizza", confidence: 0.9 },
  {
    index: ["value"],
    ttl: 60 * 24 * 30,
  }
);
```

| Option | Description                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| `index`| Controls semantic indexing. `false` disables, `null` uses server defaults, or pass `string[]` of JSON paths to index. |
| `ttl`  | Minutes before the item auto-expires. `null` disables TTL.                                                         |

> `namespace` labels must not contain `.`; the client throws if they do.

### `getItem(namespace, key, options?)`

Fetch a single item.

```ts
const item = await client.store.getItem(
  ["users", userId, "memories"],
  "favorite-food",
  { refreshTtl: true }
);
```

Returns `null` if the item doesn't exist. When set, `refreshTtl`
resets the TTL as part of the read.

### `deleteItem(namespace, key)`

```ts
await client.store.deleteItem(["users", userId, "memories"], "favorite-food");
```

### `searchItems(namespacePrefix, options?)`

Search items inside a namespace prefix. Use `query` for semantic
search when the item was put with an `index`; use `filter` for exact
JSON-subset matching.

```ts
const { items } = await client.store.searchItems(["users", userId], {
  query: "food preferences",
  filter: { type: "preference" },
  limit: 20,
});
```

| Option       | Description                                                       |
| ------------ | ----------------------------------------------------------------- |
| `query`      | Free-text semantic query (requires indexed items).                |
| `filter`     | Exact-match filter against item JSON.                             |
| `limit`      | Max results (default `10`).                                       |
| `offset`     | Pagination offset.                                                |
| `refreshTtl` | Refresh TTL for matching items.                                   |

## Namespaces

### `listNamespaces(options?)`

Inspect the namespace tree.

```ts
const { namespaces } = await client.store.listNamespaces({
  prefix: ["users", userId],
  maxDepth: 3,
  limit: 100,
});
```

| Option     | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `prefix`   | Only namespaces starting with these labels.                      |
| `suffix`   | Only namespaces ending with these labels.                        |
| `maxDepth` | Cap depth (relative to the full namespace).                      |
| `limit`    | Page size (default `100`).                                       |
| `offset`   | Pagination offset.                                               |

## Using the store from inside a graph

When a graph runs server-side, your nodes can interact with the same
store via the `BaseStore` injected into the `LangGraphRunnableConfig`.
The SDK's `client.store` is the remote management surface for that
same store — use it from your UI or backend workers.

Typical patterns:

- **Hydrate user memory before a run.** Fetch items, then pass them
  through the run's `context` / `config.configurable`.
- **Write-back after a run.** Extract structured facts from
  `thread.output` and `putItem` them under the user's namespace.
- **Semantic cache.** Put indexed items keyed by request hash; check
  `searchItems` before spawning a run.

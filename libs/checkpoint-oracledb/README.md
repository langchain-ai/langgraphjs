# @langchain/langgraph-checkpoint-oracledb

Oracle AI Database persistence for LangGraph.js. This package provides:

- `OracleCheckpointSaver`, a `BaseCheckpointSaver` implementation for graph checkpoints.
- `OracleStore`, a `BaseStore` implementation for long-term memory and optional Oracle VECTOR search.

## Requirements

- Node.js 18 or newer for runtime use.
- Oracle Database connectivity through `oracledb`.
- Oracle VECTOR support only when using `OracleStore` with an `index` configuration.

The integration tests use:

```bash
export ORACLE_USER="your_user"
export ORACLE_PASSWORD="your_password"
export ORACLE_CONNECT_STRING="host:port/service_name"
```

## Installation

```bash
pnpm add @langchain/langgraph-checkpoint-oracledb \
  @langchain/core @langchain/langgraph-checkpoint
```

## Usage

Assume `workflow` is an already configured LangGraph workflow.

```ts
import { OracleCheckpointSaver } from "@langchain/langgraph-checkpoint-oracledb";

const checkpointer = new OracleCheckpointSaver({
  connection: {
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
  },
});

// Call setup() before first use.
await checkpointer.setup();

const graph = workflow.compile({ checkpointer });
await graph.invoke(
  { input: "remember this" },
  { configurable: { thread_id: "user-123" } }
);
```

The saver supports checkpoint listing, pending writes, custom serializers,
child checkpoint namespaces, and `deleteThread(threadId)`.

Checkpoint metadata filters are evaluated in Oracle before ordering and
limiting results. Objects and arrays use recursive containment semantics, and
`null` matches only an explicitly present JSON null. Filter values must be
plain JSON; unsupported JavaScript-specific values fail before the query runs.

The checkpoint schema follows the public Python `langgraph-oracledb` saver.

Language-neutral JSON values, byte arrays, and default pending writes can be
read in both directions. A custom serializer must use compatible type tags and
bytes in both languages; language-specific values such as Python pickle or
Python-specific MessagePack extensions are not portable.

## Usage with an existing pool or connection

```ts
import oracledb from "oracledb";
import { OracleCheckpointSaver } from "@langchain/langgraph-checkpoint-oracledb";

const pool = await oracledb.createPool({
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
  connectString: process.env.ORACLE_CONNECT_STRING,
});

const checkpointer = new OracleCheckpointSaver({ pool });
await checkpointer.setup();
```

An existing pool or raw connection remains the caller's responsibility. Raw
connection operations are serialized; use a pool for concurrent graph runs.

## Store

Import `OracleStore` from the `store` subpath:

```ts
import { OracleStore } from "@langchain/langgraph-checkpoint-oracledb/store";

const store = new OracleStore({
  connection: {
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
  },
  // Uses STORE_MEMORY, shared with Python's table_suffix="memory".
  tableSuffix: "memory",
});

await store.put(["memories", "user-1"], "profile", {
  name: "Ada",
  score: 10,
});

const item = await store.get(["memories", "user-1"], "profile");
const results = await store.search(["memories"], {
  filter: { score: { $gte: 5 } },
  limit: 10,
});
```

Optional TTL values are expressed in minutes. A write may override the store
default, and searches may request a refresh for the items they return:

```ts
const store = new OracleStore({
  connection: {
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
  },
  tableSuffix: "memory",
  ttl: {
    defaultTtl: 60,
    refreshOnRead: true,
    sweepIntervalMinutes: 15,
  },
});

await store.put(
  ["memories", "user-1"],
  "temporary",
  { text: "..." },
  undefined,
  { ttl: 5 }
);
await store.search(["memories"], { refreshTtl: true });
const deletedCount = await store.sweepExpiredItems();
```

Expired items are excluded from `get`, `search`, vector search, and namespace
listing even when no sweeper is configured. `sweepExpiredItems()` deletes them;
related vector rows are removed by the shared schema's foreign-key cascade.

`OracleStore` supports `get`, `put`, `delete`, `search`, `batch`, and
`listNamespaces`. Tables are created automatically by default. Set
`ensureTable: false` when the tables must already exist.

Supported scalar filter operators are `$eq`, `$ne`, `$gt`, `$gte`, `$lt`,
`$lte`, `$in`, `$nin`, and `$exists`. Filters that cannot be translated to
bound Oracle SQL are rejected instead of being evaluated by an unbounded
client-side scan. Namespace listing supports prefix, suffix, wildcard labels,
`maxDepth`, `limit`, and `offset`.

## Store with Oracle VECTOR search

Pass an `IndexConfig` to enable vector indexing:

Assume `myEmbeddings` is a LangChain embeddings implementation compatible with
`IndexConfig`.

```ts
const store = new OracleStore({
  connection: {
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
  },
  index: {
    dims: 1536,
    embeddings: myEmbeddings,
    fields: ["text", "metadata.summary"],
  },
});

await store.put(["memories", "user-1"], "note", {
  text: "Ada likes database systems and agent memory.",
});

const results = await store.search(["memories", "user-1"], {
  query: "database memory",
  limit: 5,
});
```

VECTOR indexes are managed explicitly:

```ts
await store.createVectorIndex({
  type: "IVF",
  name: "LG_MEMORY_IVF_IDX",
  accuracy: 90,
  neighborPartitions: 1,
});

const indexes = await store.listVectorIndexes();
await store.dropVectorIndex({
  name: "LG_MEMORY_IVF_IDX",
  ifExists: true,
});
```

## Tables and cleanup

The checkpoint saver accepts `tablePrefix`, which is normalized to uppercase:

```text
<PREFIX>CHECKPOINTS
<PREFIX>CHECKPOINT_BLOBS
<PREFIX>CHECKPOINT_WRITES
<PREFIX>CHECKPOINT_MIGRATIONS
```

The Store accepts `tableSuffix` and uses the same schema, names, namespace/key
encoding, and migration history as `langgraph-oracledb` for Python:

```text
STORE_<SUFFIX>
STORE_VECTORS_<SUFFIX>
STORE_MIGRATIONS_<SUFFIX>
VECTOR_MIGRATIONS_<SUFFIX>
```

Without an index configuration the default suffix is `novec`. With an index
configuration it is derived deterministically from dimensions and fields, as
in Python. Specify the same suffix explicitly when applications in both
languages must share one Store. Empty keys are rejected because Oracle treats
an empty string as `NULL` and the shared key column is `NOT NULL`.
JavaScript currently supports `COSINE` vector distance; setup rejects a shared
Python Store configured with another distance instead of returning incorrect
rankings.

Remove checkpoint data for one thread with:

```ts
await checkpointer.deleteThread("thread-id");
```

Delete store items individually:

```ts
await store.delete(["memories", "user-1"], "profile");
```

Close resources created by the components when finished:

```ts
await store.stop();
await checkpointer.end();
```

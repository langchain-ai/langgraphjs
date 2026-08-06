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

`OracleStore` supports `get`, `put`, `delete`, `search`, `batch`, and
`listNamespaces`. Tables are created automatically by default. Set
`ensureTable: false` when the tables must already exist.

Supported filter operators are `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`,
`$in`, `$nin`, and `$exists`. Namespace listing supports prefix, suffix,
wildcard labels, `maxDepth`, `limit`, and `offset`.

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

Both components accept an optional `tablePrefix`, which is normalized to
uppercase. The prefix is used for these tables:

```text
<PREFIX>CHECKPOINTS
<PREFIX>CHECKPOINT_BLOBS
<PREFIX>CHECKPOINT_WRITES
<PREFIX>CHECKPOINT_MIGRATIONS
<PREFIX>STORE
<PREFIX>STORE_VECTORS
<PREFIX>STORE_MIGRATIONS
```

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

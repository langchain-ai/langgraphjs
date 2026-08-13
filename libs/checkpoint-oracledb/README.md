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

A `.env` in the package root works too. `pnpm test:int` refuses to start when
those variables are missing, because every test would skip and the run would
still pass. To skip deliberately, set `ALLOW_SKIPPED_ORACLE_INT_TESTS=1`.

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
limiting results. Objects and arrays use recursive containment semantics, so
`{ cfg: { a: 1 } }` matches a stored `{ cfg: { a: 1, b: 2 } }`. This matches
the `metadata @> ...` behaviour of the Postgres savers in both languages. A
filter key is always a literal key, so `{ "a.b": 1 }` looks for a key named
`a.b` rather than a nested `a` -> `b` path. `null` matches only an explicitly
present JSON null. Filter values must be plain JSON; unsupported
JavaScript-specific values fail before the query runs.

The checkpoint schema follows the public Python `langgraph-oracledb` saver.

Language-neutral JSON values, byte arrays, and default pending writes can be
read in both directions. A custom serializer must use compatible type tags and
bytes in both languages; language-specific values such as Python pickle or
Python-specific MessagePack extensions are not portable.

### What a custom serializer does and does not see

Not every value passes through the serializer. Channel values are only routed
to it when they go to the `checkpoint_blobs` table, which happens when a value
is not plain JSON or exceeds `jsonSizeThresholdMb` (1 MiB by default). Smaller
plain-JSON values stay inside the `checkpoint` column, and `metadata` is stored
as JSON at any size.

| Value | Passes through the serializer |
| --- | --- |
| Channel value over the size threshold, or not plain JSON | yes |
| Channel value that is plain JSON and under the threshold | no |
| `metadata` | no, at any size |
| Pending writes | yes |

This matters if the serializer is doing more than serialising. An encrypting
serializer, for example, will not be applied to a small
`{ "api_key": "..." }` channel value or to anything in `metadata`; both remain
readable in the database, for instance through
`JSON_SERIALIZE(checkpoint)`. Setting `jsonSizeThresholdMb: 0` forces every
non-primitive channel value through the serializer, but `metadata` and
primitive channel values are still stored as JSON.

The Python `langgraph-oracledb` saver behaves the same way, so this is a
property of the shared schema rather than of this package.

Both components also accept Python's `user/password@dsn` connection string, so
a `from_conn_string` snippet ports across unchanged:

```ts
import {
  OracleCheckpointSaver,
  OracleStore,
} from "@langchain/langgraph-checkpoint-oracledb";

const connString = "user/password@localhost:1521/FREEPDB1";

const checkpointer = OracleCheckpointSaver.fromConnString(connString);
const store = OracleStore.fromConnString(connString, {
  tableSuffix: "memory",
  poolConfig: { minSize: 1, maxSize: 10 },
});
```

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
`listNamespaces`. Tables are created automatically by default; call `setup()`
once to create them up front, or let the first operation do it. Set
`ensureTable: false` when the tables must already exist.

Non-vector search returns the most recently updated items first, and vector
search returns only items that have an embedding, both as in Python. A `query`
passed to a store with no `index` configuration is ignored rather than
rejected, again matching Python, so the result is the plain filtered listing. Text
embedded from a document matches Python's `get_text_at_path` exactly, so the
same document produces the same vector in either language.

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

### Vector index type, distance metric, and accuracy

`index.index_type` and `index.accuracy` mirror the Python `langgraph-oracledb`
options, down to the property names, because the same values are hashed into
the table suffix and stored in the shared `STORE_CONFIGS` table:

```ts
const store = new OracleStore({
  connection: oracleConnection,
  index: {
    dims: 1536,
    embeddings: myEmbeddings,
    fields: ["text"],
    accuracy: 95,
    index_type: {
      type: "hnsw", // or "ivf"
      neighbors: 16,
      efconstruction: 200,
      distance_metric: "COSINE", // or "EUCLIDEAN" / "DOT"
    },
  },
});
```

| Option | Applies to | Range |
| --- | --- | --- |
| `accuracy` | both | 1-100 |
| `distance_metric` | both | `COSINE`, `EUCLIDEAN`, `DOT` |
| `neighbors` | `hnsw` | 2-2048 |
| `efconstruction` | `hnsw` | 1-65535 |
| `neighbor_partitions` | `ivf` | 1-10000000 |
| `samples_per_partition` | `ivf` | 1 or more |
| `min_vectors_per_partition` | `ivf` | 0 or more |

Every value is validated when the store is constructed, before any statement
is built. Unknown `index_type` keys are rejected rather than ignored.

`setup()` creates the matching VECTOR index and records it as vector migration
`1`, the same as Python does, so a store is queryable through its index
straight after the first use. An HNSW index requires a database with a vector
memory area (`VECTOR_MEMORY_SIZE`); IVF does not.

Because the index configuration is part of the derived table suffix, two
stores with different index settings get their own isolated tables. When a
`tableSuffix` is given explicitly, `setup()` compares the configuration with
the one registered in `STORE_CONFIGS` and fails on a dimension, distance,
accuracy, or index parameter mismatch instead of returning wrongly ranked
rows.

The index is described entirely by the configuration; there is no separate
index-creation call, matching Python. Two build hints have no Python
equivalent and are therefore kept out of the table suffix and `STORE_CONFIGS`,
so they never change which tables a store resolves to:

```ts
const store = new OracleStore({
  connection: oracleConnection,
  index: {
    dims: 1536,
    embeddings: myEmbeddings,
    index_name: "LG_MEMORY_IVF_IDX", // default: derived from the configuration
    parallel: 4, // degree of parallelism for the index build
    index_type: { type: "ivf", neighbor_partitions: 1 },
  },
});
```

Existing indexes are reported by `getDiagnostics()` under
`vector.observedIndexes`.

## Tables and cleanup

Both components accept a `tableSuffix`. Without one the checkpoint saver uses
the bare names Python creates, so the two languages share tables by default:

```text
CHECKPOINTS             CHECKPOINTS_<SUFFIX>
CHECKPOINT_BLOBS        CHECKPOINT_BLOBS_<SUFFIX>
CHECKPOINT_WRITES       CHECKPOINT_WRITES_<SUFFIX>
CHECKPOINT_MIGRATIONS   CHECKPOINT_MIGRATIONS_<SUFFIX>
```

A suffix isolates independent checkpoint sets within one Oracle schema, which
is what `PostgresSaver` uses its `schema` option for. Python's checkpointer has
no equivalent yet, so a suffixed set is reachable only from JavaScript for now.

Suffixes follow Python's `table_suffix` rule: they must start with a letter and
contain only letters, digits, or underscores, up to 64 characters. Names are
emitted as unquoted Oracle identifiers, so they are matched case-insensitively
(`memory` and `MEMORY` address `..._MEMORY`), and anything that would require
double quoting is rejected rather than quoted.

The Store accepts `tableSuffix` and uses the same schema, names, namespace/key
encoding, and migration history as `langgraph-oracledb` for Python:

```text
STORE_<SUFFIX>
STORE_VECTORS_<SUFFIX>
STORE_MIGRATIONS_<SUFFIX>
VECTOR_MIGRATIONS_<SUFFIX>
```

Without an index configuration the default suffix is `novec`. With an index
configuration it is derived deterministically from dimensions, fields, and
index parameters, as in Python. Specify the same suffix explicitly when
applications in both languages must share one Store. Empty keys are rejected
because Oracle treats an empty string as `NULL` and the shared key column is
`NOT NULL`.

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
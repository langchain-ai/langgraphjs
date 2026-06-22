# @langchain/langgraph-checkpoint-mongodb

## 1.4.0

### Minor Changes

- [#1928](https://github.com/langchain-ai/langgraphjs/pull/1928) [`3d7fcea`](https://github.com/langchain-ai/langgraphjs/commit/3d7fcea7d7ea7f1203d24be9df607d5a8e8717bc) Thanks [@Mihailoff](https://github.com/Mihailoff)! - Add TTL support for automatic checkpoint expiration

  - Add optional `ttl` parameter to MongoDBSaver (value in seconds)
  - Add `setup()` method to create TTL indexes on collections
  - Add `upserted_at` timestamp to documents when TTL is enabled
  - Each write refreshes TTL (expires after inactivity, not creation)

### Patch Changes

- [#2556](https://github.com/langchain-ai/langgraphjs/pull/2556) [`bee3c91`](https://github.com/langchain-ai/langgraphjs/commit/bee3c91d0adc315ebde0622d8c4b1fff041c1bfd) Thanks [@mohamedkhaled4053](https://github.com/mohamedkhaled4053)! - Fix `MongoDBSaver.putWrites` throwing `MongoServerError: Invalid BulkOperation, Batch cannot be empty` when called with an empty `writes` array. This is reached by human-in-the-loop / `interrupt()` flows, where a task can complete producing zero channel writes and LangGraph calls `putWrites(config, [], taskId)`. `putWrites` now no-ops on empty writes, matching the behavior of the postgres and sqlite savers (which iterate and naturally skip empty batches).

- [#2550](https://github.com/langchain-ai/langgraphjs/pull/2550) [`2b8cc2f`](https://github.com/langchain-ai/langgraphjs/commit/2b8cc2f3fd5c9d3c33b56e013292daf5d936428e) Thanks [@lazydiv](https://github.com/lazydiv)! - feat(checkpoint-mongodb): add setup() to create required indexes

## 1.3.4

### Patch Changes

- [#2517](https://github.com/langchain-ai/langgraphjs/pull/2517) [`67a4f8d`](https://github.com/langchain-ai/langgraphjs/commit/67a4f8da580eb527fa6f201a4c72895754fe37f7) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: `MongoDBSaver.putWrites` now honors `WRITES_IDX_MAP`, pinning special channels (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) to fixed negative indices instead of the call-local ordinal. Previously a mixed `putWrites([[...regular...], [INTERRUPT, …]], taskId)` placed the INTERRUPT at a positive idx that could collide with a regular write at the same `(task_id, idx)`, and the unconditional `$set` upsert silently overwrote whichever row landed there first. The conflict-resolution clause now matches the Postgres / SQLite (TS and Python) checkpointers: `$set` only when every channel is a special one, `$setOnInsert` otherwise.

## 1.3.3

### Patch Changes

- [#2260](https://github.com/langchain-ai/langgraphjs/pull/2260) [`4d03dcb`](https://github.com/langchain-ai/langgraphjs/commit/4d03dcbc28bbfdf4c0f0ac065b9853652836d2f9) Thanks [@venkat22022202](https://github.com/venkat22022202)! - fix(mongodb): include pendingWrites in list() results

## 1.3.2

### Patch Changes

- [#2186](https://github.com/langchain-ai/langgraphjs/pull/2186) [`26c2e32`](https://github.com/langchain-ai/langgraphjs/commit/26c2e325f435a2c061d6b78a7bd6af089cb1e0e6) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: metadata filter in list() now works by querying a plain JSON shadow copy instead of the serialized binary blob

## 1.3.1

### Patch Changes

- [#2397](https://github.com/langchain-ai/langgraphjs/pull/2397) [`284226c`](https://github.com/langchain-ai/langgraphjs/commit/284226c7ca164b3c81fe2d9e32b10f1fc6b99a3c) Thanks [@hntrl](https://github.com/hntrl)! - fix(checkpoint-mongodb): validate configurable checkpoint identifiers before queries

  Add runtime validation for `thread_id`, `checkpoint_ns`, and `checkpoint_id` in
  `MongoDBSaver` methods that read and write checkpoints. This prevents object-based
  operator payloads from being passed into MongoDB query filters and ensures invalid
  configurable values fail fast with explicit errors.

## 1.3.0

### Minor Changes

- [#2326](https://github.com/langchain-ai/langgraphjs/pull/2326) [`36916ed`](https://github.com/langchain-ai/langgraphjs/commit/36916ed86e63eb07249a68ecf0508e3b986ba587) Thanks [@tadjik1](https://github.com/tadjik1)! - feat: add MongoDBStore for long-term memory

  New `MongoDBStore` class for persisting data across threads and sessions — user preferences, learned facts, agent memory, and more.

  - Store and retrieve JSON documents organized by hierarchical namespaces
  - Search with field-based filtering and comparison operators
  - Vector similarity search with manual embedding (bring your own embedding model) or auto embedding (MongoDB generates embeddings via Voyage AI)
  - Automatic document expiration via configurable TTL

## 1.2.0

### Minor Changes

- [#1991](https://github.com/langchain-ai/langgraphjs/pull/1991) [`38db67f`](https://github.com/langchain-ai/langgraphjs/commit/38db67f3599daffcbec5d04f16f36e69abe22e08) Thanks [@vanb](https://github.com/vanb)! - Add optional `enableTimestamps` parameter to `MongoDBSaver` that sets an `upserted_at` date via MongoDB's `$currentDate` operator on every upsert. Useful for MongoDB TTL indexes, auditing, or debugging.

## 1.1.7

### Patch Changes

- [#1943](https://github.com/langchain-ai/langgraphjs/pull/1943) [`814c76d`](https://github.com/langchain-ai/langgraphjs/commit/814c76dc3938d0f6f7e17ca3bc11d6a12270b2a1) Thanks [@hntrl](https://github.com/hntrl)! - fix(mongodb): validate filter values are primitives

  Added validation to ensure filter values in the `list()` method are primitive types
  (string, number, boolean, or null).

## 1.1.6

### Patch Changes

- [#1862](https://github.com/langchain-ai/langgraphjs/pull/1862) [`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c) Thanks [@dqbd](https://github.com/dqbd)! - retry release: Updates the checkpoint-mongodb to append client metadata

## 1.1.5

### Patch Changes

- [#1856](https://github.com/langchain-ai/langgraphjs/pull/1856) [`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: Updates the checkpoint-mongodb to append client metadata

## 1.1.4

### Patch Changes

- [#1853](https://github.com/langchain-ai/langgraphjs/pull/1853) [`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: Updates the checkpoint-mongodb to append client metadata

## 1.1.3

### Patch Changes

- [#1850](https://github.com/langchain-ai/langgraphjs/pull/1850) [`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: Updates the checkpoint-mongodb to append client metadata

## 1.1.2

### Patch Changes

- 3ec85a4: retry release: Updates the checkpoint-mongodb to append client metadata

## 1.1.1

### Patch Changes

- 3613386: retry release: Updates the checkpoint-mongodb to append client metadata

## 1.1.0

### Minor Changes

- 4b7832e: Updates the checkpoint-mongodb to append client metadata

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0

## 0.1.1

### Patch Changes

- 11c7807: Add support for @langchain/core 1.0.0-alpha

## 0.1.0

### Minor Changes

- ccbcbc1: Add delete thread method to checkpointers
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [3fd7f73]

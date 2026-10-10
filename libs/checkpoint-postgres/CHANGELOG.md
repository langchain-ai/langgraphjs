# @langchain/langgraph-checkpoint-postgres

## 1.1.0

### Minor Changes

- [#2961](https://github.com/langchain-ai/langgraphjs/pull/2961) [`1631fd8`](https://github.com/langchain-ai/langgraphjs/commit/1631fd895723c4553345ceb5d9fc425b68bda959) Thanks [@soarez](https://github.com/soarez)! - order parallel writes by task path, like langgraph (Python) — one sort key for live execution and every saver, instead of the task-id order [#2544](https://github.com/langchain-ai/langgraphjs/issues/2544) added for DeltaChannel writes
  
  When two or more tasks in one superstep write the same `DeltaChannel`, their writes are now applied and replayed in `(task_path, task_id, idx)` order — the order Python's langgraph#8544 established — instead of task-id order. Task ids are uuid5 hashes that include the checkpoint id, so the old order permuted parallel writers from run to run and disagreed with Python.
  
  - `BaseCheckpointSaver.putWrites` takes an optional `taskPath` (the serialized task path, `taskPathStr`), and `getTuple`/`list` must return `pendingWrites` in the new `writesSortKey` order. `writesSortKey` and `compareWritesSortKeys` are new exports of `@langchain/langgraph-checkpoint`; every saver (memory, SQLite, Postgres, Redis incl. ShallowRedisSaver, MongoDB) stores the path and sorts in JS — no database collation is involved.
  - SQLite and Postgres gain a `task_path` column (migrated automatically on `setup()`; read-only pre-column SQLite databases keep reading, with their rows keeping the old order). Redis and MongoDB documents gain a `task_path` field. Rows written before the upgrade keep their old order.
  - Exit-durability resumes replay delta writes in live order (port of langgraph#9114): the resumed superstep's writes interleave with the loaded ones by task path, later supersteps sort after every real write, and writes loaded with the checkpoint are no longer stored twice.
  - `bulkUpdateState` seals the first update superstep: DeltaChannels touched by the base checkpoint's pending writes (and whose version moved) snapshot on the update checkpoint, so a finished sibling's writes and the update's can't replay in the wrong order (partial port of langgraph#8548).
  - `bulkUpdateState`/`updateState` update tasks carry `(__interrupt__, i)` task paths, as in langgraph#9128, so several updates in one superstep writing the same DeltaChannel replay in the order given.
  - Send task paths become `[PUSH, i, false]` and node-error-handler paths become `[*failedTask.path[:3], "node_error_handler", false]` (the failed task's first three path elements), matching Python's shapes — `langgraph_path` task metadata changes accordingly, and task ids of functional `task()` calls under a Send or handler task change with them. The SDK's Send-task detection accepts both the old and new shapes.
  
  Upgrade notes:
  
  - `PostgresSaver`: run `setup()` once after upgrading, from one process, before the new version serves traffic. The `task_path` column comes from the first new migration since the saver shipped, and until it runs, reads and writes fail with `column "task_path" does not exist`. Several processes running `setup()` at once on a database that still needs the migration can fail with a duplicate key error on `checkpoint_migrations`.
  - Third-party checkpoint savers remain source-compatible but must now persist the `taskPath` they are given and return `pendingWrites` in `writesSortKey` order; the conformance suite's new base tests enforce this. A saver that ignores the new argument replays in task-id order and can rebuild a different DeltaChannel value than the run produced.
  - An incomplete superstep containing stored delta writes that must interleave with resumed or retried task writes is affected by the upgrade, whether the incompleteness came from an interrupt, a task error, a crash, or a drain: finish such threads with the old runtime before upgrading writers. A single interrupted node with no finished delta-writing siblings is safe to resume. The same applies to resuming work that includes functional `task()` calls under a Send or error-handler task, whose child task ids change.
  - `@langchain/langgraph-checkpoint` 1.2.0 must be released before any package requiring its new exports; the consumers' minimum ranges are raised accordingly.

## 1.0.6

### Patch Changes

- [#2825](https://github.com/langchain-ai/langgraphjs/pull/2825) [`a1f9393`](https://github.com/langchain-ai/langgraphjs/commit/a1f9393b771606b1ad636c1f4555cd70cb083dea) Thanks [@byhow](https://github.com/byhow)! - Match Postgres store namespace prefixes and suffixes at segment boundaries. Validate namespace listing filters, escape namespace LIKE patterns, and reject colons inside namespace labels to prevent ambiguous paths.
  
  Align namespace listing `*` wildcards with InMemoryStore: match exactly one segment while treating stars embedded in labels literally.

## 1.0.5

### Patch Changes

- [#2714](https://github.com/langchain-ai/langgraphjs/pull/2714) [`a2a59ec`](https://github.com/langchain-ai/langgraphjs/commit/a2a59ec6f8fdd93d4520d86fceab8a234dacf978) Thanks [@hntrl](https://github.com/hntrl)! - Update checkpoint integrations to require the patched checkpoint serializer release.

## 1.0.4

### Patch Changes

- [#2566](https://github.com/langchain-ai/langgraphjs/pull/2566) [`091a46f`](https://github.com/langchain-ai/langgraphjs/commit/091a46f32ddd3a85ee89e35fb9ea953dfc4cf8b4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(langgraph-checkpoint-postgres): prevent createAgent failures with PostgresSaver

  Add BaseCheckpointSaver.toJSON() so ConfigurableModel can stringify runnable config without traversing pg Pool timers, and default missing checkpoint maps on load/copy so resume no longer crashes on undefined versions_seen. Closes [#1808](https://github.com/langchain-ai/langgraphjs/issues/1808).

## 1.0.3

### Patch Changes

- [#2512](https://github.com/langchain-ai/langgraphjs/pull/2512) [`375c73f`](https://github.com/langchain-ai/langgraphjs/commit/375c73fcd1ef06145301df80466fda35c0a99385) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: reject SQL `LIKE` wildcards (`%`, `_`) and the backslash escape character in `PostgresStore` namespace labels. `BaseStore.search()` matches namespaces via `namespace_path LIKE ${prefix}%`, and these characters in caller-supplied namespace labels are interpreted as wildcards by Postgres even through a bound parameter — letting a namespace prefix of `["%"]` match every namespace in the store across tenants. `validateNamespace` now throws for these characters at all `search` / `get` / `put` entrypoints, keeping store-wide consistency. CWE-1336.

## 1.0.2

### Patch Changes

- [#2255](https://github.com/langchain-ai/langgraphjs/pull/2255) [`e82a50b`](https://github.com/langchain-ai/langgraphjs/commit/e82a50b961a9413dab1ad2248747d5c73a6a1e58) Thanks [@leesta24](https://github.com/leesta24)! - fix(checkpoint-postgres): move serialization outside transaction in put()

## 1.0.1

### Patch Changes

- [#1979](https://github.com/langchain-ai/langgraphjs/pull/1979) [`d65f5a7`](https://github.com/langchain-ai/langgraphjs/commit/d65f5a75e58e282fea831d8f126391823f241a78) Thanks [@Siretu](https://github.com/Siretu)! - fix: quote PostgreSQL schema identifiers to support schemas with dashes

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0

## 0.1.2

### Patch Changes

- 11c7807: Add support for @langchain/core 1.0.0-alpha

## 0.1.1

### Patch Changes

- 42ced3a: Add Store implemention for Postgres

## 0.1.0

### Minor Changes

- ccbcbc1: Add delete thread method to checkpointers
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [3fd7f73]

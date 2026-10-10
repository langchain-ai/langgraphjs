# @langchain/langgraph-checkpoint-sqlite

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

## 1.0.4

### Patch Changes

- [#2714](https://github.com/langchain-ai/langgraphjs/pull/2714) [`a2a59ec`](https://github.com/langchain-ai/langgraphjs/commit/a2a59ec6f8fdd93d4520d86fceab8a234dacf978) Thanks [@hntrl](https://github.com/hntrl)! - Update checkpoint integrations to require the patched checkpoint serializer release.

## 1.0.3

### Patch Changes

- [#2516](https://github.com/langchain-ai/langgraphjs/pull/2516) [`f6a6d26`](https://github.com/langchain-ai/langgraphjs/commit/f6a6d26b7e69003c4fa052f3cd3319f3e72f0f8f) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: `SqliteSaver.putWrites` now honors `WRITES_IDX_MAP`, pinning special channels (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) to fixed negative indices instead of the call-local ordinal. Previously a follow-up `putWrites([[INTERRUPT, …]], taskId)` for the same checkpoint silently `REPLACE`d the regular write previously stored at `idx=0` for that task, losing data. The conflict-resolution clause also now matches the Python checkpointer contract: `OR REPLACE` only when every channel is a special one (so e.g. INTERRUPT→RESUME state transitions overwrite), `OR IGNORE` otherwise.

## 1.0.2

### Patch Changes

- [#2504](https://github.com/langchain-ai/langgraphjs/pull/2504) [`e8a0940`](https://github.com/langchain-ai/langgraphjs/commit/e8a09409ac4a997012e78081160c91188ebe39fc) Thanks [@jackjin1997](https://github.com/jackjin1997)! - fix: `SqliteSaver.list({}, { filter })` now honors arbitrary metadata keys (e.g. `tenant_id`, `env`), matching the behavior of the MongoDB, Postgres, and Redis checkpointers. Previously only `source`, `step`, and `parents` were honored — any other key was silently dropped, returning unfiltered results.

## 1.0.1

### Patch Changes

- [#1902](https://github.com/langchain-ai/langgraphjs/pull/1902) [`2378b9e`](https://github.com/langchain-ai/langgraphjs/commit/2378b9e951ff245a3e8a502acf42be55cce35a46) Thanks [@warjiang](https://github.com/warjiang)! - chore: upgrade better-sqlite

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

### Patch Changes

- Updated dependencies [1e1ecbb]
  - @langchain/langgraph-checkpoint@1.0.0

## 0.2.1

### Patch Changes

- 11c7807: Add support for @langchain/core 1.0.0-alpha

## 0.2.0

### Minor Changes

- ccbcbc1: Add delete thread method to checkpointers
- Updated dependencies [773ec0d]
  - @langchain/langgraph-checkpoint@0.1.0

### Patch Changes

- Updated dependencies [ccbcbc1]
- Updated dependencies [10f292a]
- Updated dependencies [3fd7f73]

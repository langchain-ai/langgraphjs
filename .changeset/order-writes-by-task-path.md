---
"@langchain/langgraph-checkpoint": minor
"@langchain/langgraph": minor
"@langchain/langgraph-checkpoint-sqlite": minor
"@langchain/langgraph-checkpoint-postgres": minor
"@langchain/langgraph-checkpoint-redis": minor
"@langchain/langgraph-checkpoint-mongodb": minor
"@langchain/langgraph-checkpoint-validation": minor
"@langchain/langgraph-api": patch
"@langchain/langgraph-sdk": patch
---

order parallel writes by task path, like langgraph (Python) — one sort key for live execution and every saver, instead of the task-id order #2544 added for DeltaChannel writes

When two or more tasks in one superstep write the same `DeltaChannel`, their writes are now applied and replayed in `(task_path, task_id, idx)` order — the order Python's langgraph#8544 established — instead of task-id order. Task ids are uuid5 hashes that include the checkpoint id, so the old order permuted parallel writers from run to run and disagreed with Python.

- `BaseCheckpointSaver.putWrites` takes an optional `taskPath` (the serialized task path, `taskPathStr`), and `getTuple`/`list` must return `pendingWrites` in the new `writesSortKey` order. `writesSortKey` and `compareWritesSortKeys` are new exports of `@langchain/langgraph-checkpoint`; every saver (memory, SQLite, Postgres, Redis incl. ShallowRedisSaver, MongoDB) stores the path and sorts in JS — no database collation is involved.
- SQLite and Postgres gain a `task_path` column (migrated automatically on `setup()`; read-only pre-column SQLite databases keep reading, with their rows keeping the old order). Redis and MongoDB documents gain a `task_path` field. Rows written before the upgrade keep their old order.
- Exit-durability resumes replay delta writes in live order (port of langgraph#9114): the resumed superstep's writes interleave with the loaded ones by task path, later supersteps sort after every real write, and writes loaded with the checkpoint are no longer stored twice.
- `bulkUpdateState` seals the first update superstep: DeltaChannels touched by the base checkpoint's pending writes (and whose version moved) snapshot on the update checkpoint, so a finished sibling's writes and the update's can't replay in the wrong order (partial port of langgraph#8548).
- `bulkUpdateState`/`updateState` update tasks carry `(__interrupt__, i)` task paths, as in langgraph#9128, so several updates in one superstep writing the same DeltaChannel replay in the order given.
- Send task paths become `[PUSH, i, false]` and node-error-handler paths become `[*failedTask.path[:3], "node_error_handler", false]` (the failed task's first three path elements), matching Python's shapes — `langgraph_path` task metadata changes accordingly, and task ids of functional `task()` calls under a Send or handler task change with them. The SDK's Send-task detection accepts both the old and new shapes.

Upgrade notes:

- Third-party checkpoint savers remain source-compatible but must now persist the `taskPath` they are given and return `pendingWrites` in `writesSortKey` order; the conformance suite's new base tests enforce this. A saver that ignores the new argument replays in task-id order and can rebuild a different DeltaChannel value than the run produced.
- An incomplete superstep containing stored delta writes that must interleave with resumed or retried task writes is affected by the upgrade, whether the incompleteness came from an interrupt, a task error, a crash, or a drain: finish such threads with the old runtime before upgrading writers. A single interrupted node with no finished delta-writing siblings is safe to resume. The same applies to resuming work that includes functional `task()` calls under a Send or error-handler task, whose child task ids change.
- `@langchain/langgraph-checkpoint` 1.2.0 must be released before any package requiring its new exports; the consumers' minimum ranges are raised accordingly.

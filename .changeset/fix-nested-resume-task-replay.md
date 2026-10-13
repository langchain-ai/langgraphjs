---
"@langchain/langgraph": patch
---

fix(langgraph): replay task results on nested resume

A subgraph's loop receives `checkpoint_id` as a key in its `configurable`, so
`skipDoneTasks` was false on every nested run and the recorded pending writes
were never applied, so a `task()` that completed before an `interrupt()` ran its
body again on each resume — one duplicated side effect per resume. A nested
run now applies the pending writes unless it is replaying a checkpoint
(`isTimeTraveling`, the predicate `_first()` already uses to drop stale
`RESUME` writes). A top-level run keeps gating on `skipDoneTasks`.

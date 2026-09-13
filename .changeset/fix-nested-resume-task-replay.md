---
"@langchain/langgraph": patch
---

fix(langgraph): replay task results on nested resume

A subgraph's loop receives `checkpoint_id` as a key in its `configurable`, so
`skipDoneTasks` was false on every nested run and the recorded pending writes
were never applied, so a `task()` that completed before an `interrupt()` ran its
body again on each resume — one duplicated side effect per resume. Gate applying
pending writes on `isTimeTraveling`, the predicate `_first()` already uses to
drop stale `RESUME` writes. `skipDoneTasks` is untouched, so the subgraph
time-travel behaviour it guards is unchanged.

---
"@langchain/langgraph-checkpoint-mongodb": patch
---

fix: `MongoDBSaver.putWrites` now honors `WRITES_IDX_MAP`, pinning special channels (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) to fixed negative indices instead of the call-local ordinal. Previously a mixed `putWrites([[...regular...], [INTERRUPT, …]], taskId)` placed the INTERRUPT at a positive idx that could collide with a regular write at the same `(task_id, idx)`, and the unconditional `$set` upsert silently overwrote whichever row landed there first. The conflict-resolution clause now matches the Postgres / SQLite (TS and Python) checkpointers: `$set` only when every channel is a special one, `$setOnInsert` otherwise.

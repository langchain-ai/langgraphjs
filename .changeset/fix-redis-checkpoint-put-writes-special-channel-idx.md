---
"@langchain/langgraph-checkpoint-redis": patch
---

fix: `RedisSaver.putWrites` now honors `WRITES_IDX_MAP`, pinning special channels (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) to fixed negative indices in their Redis key (`checkpoint_write:…:<idx>`) instead of the call-local ordinal. Previously a mixed `putWrites([[…regular…], [INTERRUPT, …]], taskId)` placed the INTERRUPT key at the positive idx of its position in the batch, where a peer task's regular write at the same idx would overwrite it via the unconditional `JSON.SET`. The conflict-resolution clause now matches Postgres / SQLite / MongoDB: unguarded `JSON.SET` when every write is a special channel, `JSON.SET … NX` (insert-or-ignore) otherwise.

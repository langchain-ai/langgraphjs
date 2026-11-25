---
"@langchain/langgraph-checkpoint-redis": patch
---

`RedisSaver` and `ShallowRedisSaver` now persist new keys and their TTLs in a single MULTI/EXEC transaction. Previously `put()` and `putWrites()` wrote keys first and applied `ttlConfig.defaultTTL` in a separate `EXPIRE` pass, so a crash between the two (or a failed `EXPIRE`, which was only logged) left checkpoint data without a TTL forever.

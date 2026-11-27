---
"@langchain/langgraph-checkpoint-redis": patch
---

`RedisSaver.getTuple` without a `checkpoint_id` now finds the latest checkpoint through the `checkpoints` search index, and pending writes are read from the per-checkpoint write-key set, instead of running `KEYS`. `KEYS` scans the whole database and blocks Redis while it runs, so each read slowed down as the total number of checkpoints grew. The returned tuples are unchanged. The fallback for a missing search index now also recognizes the error wording of Redis 8 and Redis Stack 7.

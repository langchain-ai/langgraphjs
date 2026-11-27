---
"@langchain/langgraph-checkpoint-redis": patch
---

`RedisSaver.put` and `putWrites` take fewer round trips. The indexes are created once per saver instead of before every write, and created again if a search finds them missing. `putWrites` sends its writes, sorted set and TTLs together and sets `has_writes` with a path update instead of reading and rewriting the whole checkpoint. `put` checks for pending writes alongside the blob writes. Stored data is unchanged.

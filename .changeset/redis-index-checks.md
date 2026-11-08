---
"@langchain/langgraph-checkpoint-redis": patch
---

`RedisSaver` and `ShallowRedisSaver` send the index checks they run before every write together, in one round trip instead of one per index. A 100-step loop on `RedisSaver` runs 1.44x faster.

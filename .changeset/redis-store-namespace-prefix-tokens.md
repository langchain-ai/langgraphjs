---
"@langchain/langgraph-checkpoint-redis": patch
---

Scope RedisStore searches to exact namespace segments and descendants using case-sensitive TAG matching. Scope get, update, and delete to the exact namespace. Setup adds the namespace TAG field to existing indexes without rewriting documents; rerun setup after upgrading.

---
"@langchain/langgraph-checkpoint-redis": patch
---

Scope RedisStore searches to exact namespace segments and descendants using case-sensitive TAG matching. Scope get, update, and delete to the exact namespace. Setup adds namespace TAG fields and backfills complete ancestor prefixes on existing documents, preserving values and TTLs. Stop old clients and rerun setup before serving traffic. Exact prefix tags avoid Redis wildcard-expansion limits; vector pagination now orders enough neighbors for the requested offset.

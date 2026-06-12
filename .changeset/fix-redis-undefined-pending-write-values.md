---
"@langchain/langgraph-checkpoint-redis": patch
---

Fix Redis checkpoint pending write deserialization when a write document has no `value` field. RedisJSON omits `undefined` values, so `loadPendingWrites` now restores a missing `value` as `undefined` instead of passing it through JSON parsing.

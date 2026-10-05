---
"@langchain/langgraph-checkpoint-redis": patch
---

fix(checkpoint-redis): check each `RedisStore` document's namespace exactly before returning, replacing or deleting it, so `["tenant", "a"]` no longer matches documents stored under `["a", "tenant"]`, `["tenant", "A"]` or `["tenant", "a-b"]`. Upgrade every process that writes to the store, since older versions can still overwrite or delete other namespaces' documents.

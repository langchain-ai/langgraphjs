---
"@langchain/langgraph-checkpoint-redis": patch
---

Scope RedisStore reads and mutations to exact namespaces and search to exact namespaces and descendants. Setup adds a case-sensitive TAG index over the existing namespace field without rewriting documents. Search enumerates namespace tags to avoid wildcard expansion limits and scopes results before pagination and vector selection. Existing index definitions and readiness are checked before setup completes.

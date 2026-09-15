---
"@langchain/langgraph-checkpoint-redis": patch
---

Scope RedisStore reads and mutations to exact namespaces and search to exact namespaces and descendants. Setup adds a case-sensitive TAG index over the existing namespace field without rewriting documents. Search enumerates namespace tags to avoid wildcard expansion limits and scopes results before pagination and vector selection. Existing index definitions and readiness are checked before setup completes. Namespace operations verify index readiness before queries and report a setup error when the required field is absent or incompatible. The original TEXT field remains available to older clients. Lookup failures stop mutations instead of being treated as missing records.

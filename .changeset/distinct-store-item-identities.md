---
"@langchain/langgraph-checkpoint": patch
---

Preserve namespace and key boundaries when deduplicating InMemoryStore batch operations and vector search results, so keys containing colons do not collide with items in nested namespaces.

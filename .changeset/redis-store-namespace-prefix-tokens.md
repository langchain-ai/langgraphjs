---
"@langchain/langgraph-checkpoint-redis": patch
---

Scope `RedisStore` vector search to every label of the namespace prefix instead of only the first one, and build both search namespace clauses through a shared helper so vector and plain search filter identically. The helper now splits labels on the same punctuation RediSearch tokenizes on, so a namespace label can no longer inject query syntax into the prefix clause.

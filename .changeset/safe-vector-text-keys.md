---
"@langchain/langgraph-checkpoint": patch
---

Fix InMemoryStore vector indexing failing for texts such as `constructor`, `toString`, and `__proto__`. Preserve embedding deduplication across fields and documents.

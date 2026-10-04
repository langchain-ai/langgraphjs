---
"@langchain/langgraph-checkpoint": patch
---

Preserve per-item indexing options in AsyncBatchedStore.put. Graph nodes can now disable embeddings with `index: false`, select custom or wildcard fields, and override default indexing consistently with the underlying store.

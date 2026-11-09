---
"@langchain/langgraph-checkpoint": patch
---

Remove an item's vectors when deleting it from `InMemoryStore`, so recreating the same key cannot reuse embeddings from the deleted item.

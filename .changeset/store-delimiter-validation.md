---
"@langchain/langgraph-checkpoint": patch
---

Reject dotted namespace labels in BaseStore reads, deletes and namespace-listing filters, and validate AsyncBatchedStore operations before queueing them. Preserve hierarchical search and empty-prefix searches.

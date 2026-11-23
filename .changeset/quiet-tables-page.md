---
"@langchain/langgraph-checkpoint": patch
---

Apply the remaining search offset to unindexed items in InMemoryStore vector search, preventing duplicate results across pages and returning an empty page past the end of the results.

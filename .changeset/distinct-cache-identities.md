---
"@langchain/langgraph-checkpoint": patch
---

Preserve namespace segment boundaries and treat string keys as data in `InMemoryCache`. Distinct namespaces no longer overwrite, clear, or expire one another's entries when their segments contain commas or empty strings.

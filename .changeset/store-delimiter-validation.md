---
"@langchain/langgraph-checkpoint": patch
---

Reject namespace labels that are empty, non-string or contain a period in `BaseStore` gets, deletes and namespace-listing filters, matching search. `AsyncBatchedStore` (the store graph nodes receive) now runs these checks before queueing, so a namespace that fails them rejects only its own call rather than its whole batch. Its gets, deletes and searches use the same label checks, and its puts follow `BaseStore.put`: in-graph puts now also reject an empty namespace or a `langgraph` root label, even if the wrapped store (such as `InMemoryStore`) accepts them. Hierarchical prefix search, empty-prefix search and `*` namespace-listing wildcards are unchanged.

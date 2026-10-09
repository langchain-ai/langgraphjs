---
"@langchain/langgraph-checkpoint": patch
---

Reject namespace labels that are empty, non-string or contain a period in `BaseStore` gets, deletes and namespace-listing filters, matching search. Stores that use these `BaseStore` methods, such as `MongoDBStore`, now throw `InvalidNamespaceError` for such labels instead of returning no results. `AsyncBatchedStore` (the store graph nodes receive) runs the same checks before queueing, so a namespace that fails them rejects only its own call; checks specific to the wrapped store, such as the `:` separator check in `InMemoryStore` and the Postgres store, still run inside its batch. Its puts follow `BaseStore.put`, so in-graph puts now reject a `langgraph` root label (and an empty namespace) even if the wrapped store would accept it; for `InMemoryStore` only the `langgraph` root is newly rejected. Hierarchical prefix search, empty-prefix search and `*` namespace-listing wildcards are unchanged.

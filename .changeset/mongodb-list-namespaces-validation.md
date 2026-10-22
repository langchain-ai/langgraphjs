---
"@langchain/langgraph-checkpoint-mongodb": patch
---

`MongoDBStore` validates list namespaces operations, including ones passed straight to `batch()`: match conditions must be `prefix` or `suffix`, their labels follow the same rules as `listNamespaces()`, and `maxDepth` must be a non-negative integer. Puts and deletes passed to `batch()` now use the same shared namespace validation as `put()`, so labels containing `:` or NUL bytes are rejected there too. Invalid input throws `InvalidNamespaceError` before any query runs.

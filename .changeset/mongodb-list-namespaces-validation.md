---
"@langchain/langgraph-checkpoint-mongodb": patch
---

`MongoDBStore` validates list namespaces operations, including ones passed straight to `batch()`: match conditions must be `prefix` or `suffix`, their labels follow the same rules as `listNamespaces()`, and `maxDepth` must be a non-negative integer. Invalid input throws `InvalidNamespaceError` before any query runs.

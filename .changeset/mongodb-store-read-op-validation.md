---
"@langchain/langgraph-checkpoint-mongodb": patch
---

`MongoDBStore` validates get, search, put and delete operations, including ones passed straight to `batch()`: namespaces and search prefixes must be arrays of strings, and keys must be strings. Invalid input throws before any query runs.

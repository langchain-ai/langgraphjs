---
"@langchain/langgraph-checkpoint-mongodb": patch
---

`MongoDBStore` now wraps item keys and namespaces, search namespace prefix labels and filter `$eq` operands in `$eq` when building queries, including for operations passed straight to `batch()`, so an object value is matched as a plain value instead of being read as a query operator. String and number values match exactly as before.

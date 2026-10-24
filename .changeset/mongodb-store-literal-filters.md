---
"@langchain/langgraph-checkpoint-mongodb": patch
---

`MongoDBStore` now rejects a get or delete whose namespace is not an array, and wraps item keys, search namespace prefix labels and filter `$eq` operands in `$eq` when building queries, including for operations passed straight to `batch()`. An object value is matched as a plain value instead of being read as a query operator. String and number values match exactly as before.

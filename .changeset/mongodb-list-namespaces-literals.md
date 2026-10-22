---
"@langchain/langgraph-checkpoint-mongodb": patch
---

`MongoDBStore` validates list namespaces operations, including ones passed straight to `batch()`: match conditions must be `prefix` or `suffix` with string labels, and `maxDepth` must be a non-negative integer. Labels are compared as literals, so a namespace stored under a label that starts with `$` can now be listed by it.

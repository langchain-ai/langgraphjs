---
"@langchain/langgraph-checkpoint-mongodb": patch
---

fix: validate `thread_id`, `checkpoint_ns`, and `checkpoint_id` in `MongoDBSaver` to prevent NoSQL operator injection. Object/function values for these fields are now rejected before they reach a MongoDB query, mirroring the existing guard on the `filter` argument of `list()`. Applies to `getTuple`, `list`, `put`, and `putWrites`.

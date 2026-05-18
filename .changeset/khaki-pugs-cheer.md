---
"@langchain/langgraph-checkpoint-mongodb": patch
---

fix(checkpoint-mongodb): validate configurable checkpoint identifiers before queries

Add runtime validation for `thread_id`, `checkpoint_ns`, and `checkpoint_id` in
`MongoDBSaver` methods that read and write checkpoints. This prevents object-based
operator payloads from being passed into MongoDB query filters and ensures invalid
configurable values fail fast with explicit errors.

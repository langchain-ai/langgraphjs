---
"@langchain/langgraph-checkpoint-mongodb": patch
---

Fix `MongoDBSaver.putWrites` throwing `MongoServerError: Invalid BulkOperation, Batch cannot be empty` when called with an empty `writes` array. This is reached by human-in-the-loop / `interrupt()` flows, where a task can complete producing zero channel writes and LangGraph calls `putWrites(config, [], taskId)`. `putWrites` now no-ops on empty writes, matching the behavior of the postgres and sqlite savers (which iterate and naturally skip empty batches).

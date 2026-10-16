---
"@langchain/langgraph-checkpoint-postgres": patch
---

Loading a checkpoint that holds a stored value over about 61 MB no longer aborts the process with `FATAL ERROR: invalid array length`: checkpoint reads parse their `bytea[]` columns with `postgres-array` 3 instead of the version `pg` 8 depends on, still in one query. Threads that already crash on load become readable again; stored data doesn't change.

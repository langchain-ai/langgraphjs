---
"@langchain/langgraph-checkpoint-sqlite": patch
---

fix: `SqliteSaver.list({}, { filter })` now honors arbitrary metadata keys (e.g. `tenant_id`, `env`), matching the behavior of the MongoDB, Postgres, and Redis checkpointers. Previously only `source`, `step`, and `parents` were honored — any other key was silently dropped, returning unfiltered results.

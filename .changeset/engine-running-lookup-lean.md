---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now selects only `run_id` and `kwargs` when looking up a thread's running run on open, and avoids opening and immediately aborting the `/threads/:id/stream` watcher while joining a running run.

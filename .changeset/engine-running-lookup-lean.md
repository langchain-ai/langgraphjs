---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now selects only `run_id` and `kwargs` when looking up a thread's running run on open, skips the second running-run lookup once the first lookup has already joined a run, and avoids opening and immediately aborting the `/threads/:id/stream` watcher while joining a running run.

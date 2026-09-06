---
"@langchain/langgraph-sdk": patch
---

Send `checkpoint_id` in the `runs.stream()` request body, so a `checkpointId` passed to `client.runs.stream()` forks from the requested checkpoint instead of being silently dropped. Matches `runs.create()` and `runs.wait()`, which already send it.

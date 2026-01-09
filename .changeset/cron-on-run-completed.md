---
"@langchain/langgraph-sdk": minor
---

Add `onRunCompleted` parameter to `CronsClient.create()` for controlling thread cleanup behavior in stateless crons. Options are `"delete"` (default) to automatically clean up threads, or `"keep"` to preserve threads for later retrieval.

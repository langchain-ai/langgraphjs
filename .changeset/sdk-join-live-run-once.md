---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator.joinStream(runId)` now does nothing when `runId` is the run it is already streaming or has queued, instead of replaying the run once the current stream ends.

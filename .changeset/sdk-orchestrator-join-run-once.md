---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator.joinStream(runId)` now does nothing when `runId` is the run it is already streaming (from `submit()` or an earlier join, including the one `reconnectOnMount` starts) or has queued, and returns that stream's promise. Previously the second join waited for the current stream to end and then replayed the whole run, with a second loading phase and another history read. A run whose stream `stop()` or a thread switch cut off can still be joined again right away.

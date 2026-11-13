---
"@langchain/langgraph-sdk": patch
---

After `stop()`, `StreamOrchestrator` keeps the messages it showed that the server didn't save, such as the input of a run stopped before the server saved it, after the saved ones, until the next run, a reload or a thread switch. A reply the stop cut off mid-stream still goes. `CustomStreamOrchestrator` now drops that reply too, and keeps the rest of the run's values. The `read` that `StreamManager.stop()` takes gets the values the stream showed, without what it streamed since its last root `values` event.

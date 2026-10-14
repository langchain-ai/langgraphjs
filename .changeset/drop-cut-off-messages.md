---
"@langchain/langgraph-sdk": patch
---

fix(sdk): a reply cut off mid-stream, for example by `stop()`, no longer lingers in `useStream` messages after its run ends: it is dropped as soon as the run ends, stays gone after a page refresh, and is dropped in other tabs watching the thread too. A reply that finished streaming before the run paused for input stays visible while paused and is replaced, not duplicated, when the run resumes. Streaming message handles for a cut-off message now settle with an `aborted` error instead of never resolving.

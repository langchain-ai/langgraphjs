---
"@langchain/langgraph-sdk": patch
---

When a headless tool finishes after a switch to another thread, `StreamOrchestrator` no longer sends its result to the new thread, keyed by the previous thread's interrupt id, and the `useStream` hook no longer streams the previous thread's resumed run into the new thread's view and no longer aborts a run the new thread is streaming. The call stays pending on its own thread and runs again when that thread is shown.

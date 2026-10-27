---
"@langchain/langgraph-sdk": patch
---

`stop()` in the `useStream` hook and `StreamOrchestrator` no longer loses the session. Without history and without an `onFinish` that takes the thread state, stopping a running stream put back the thread state read when the thread opened, so the turns sent since disappeared and `onStop` edits were overwritten. A stop now reads the thread and shows what the server kept, with the `onStop` edits applied on top. With or without history, a stop no longer shows the cancellation as an error, or the node it cut off as a breakpoint.

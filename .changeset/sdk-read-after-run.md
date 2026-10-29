---
"@langchain/langgraph-sdk": patch
---

Without history, the `useStream` hook and `StreamOrchestrator` now read the thread again after a run that succeeds when the state shown had an interrupt, a node still to run or a task error, so an answered approval no longer comes back and an old error goes away. A run on a thread that showed none of these makes no extra request, and a failed read reports no error. With history, a failed read after a run no longer fails the run in the hook or skips `onFinish` in `StreamOrchestrator`.

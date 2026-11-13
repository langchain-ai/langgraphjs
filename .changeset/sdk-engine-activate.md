---
"@langchain/langgraph-sdk": patch
---

A thread load before `StreamOrchestrator`'s first `activate()` reads the thread and holds what it finds until then: the running run's join, the head's headless tool calls and the server's queued runs. Bindings create the engine during a render, and an engine from a render that never commits, such as StrictMode's double render or a suspended tree that unmounts, used to join runs, run tools a second time and send their answers again. A running run a load holds counts as `isLoading`. Submits, a run's end and `drainQueue()` don't wait for `activate()`. `respond()` with no id now answers the first interrupt shown, as `CustomStreamOrchestrator` does.

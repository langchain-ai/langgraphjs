---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` joins a thread's running run, runs the head's headless tool calls and streams the server's queued runs only after its first `activate()`. Bindings create the engine during a render, and an engine from a render that never commits, such as StrictMode's double render or a suspended tree that unmounts, used to join runs, run tools a second time and send their answers again. Before `activate()`, a load still reads the thread, and a running run it found counts as `isLoading`. `respond()` with no id now answers the first interrupt shown, as `CustomStreamOrchestrator` does.

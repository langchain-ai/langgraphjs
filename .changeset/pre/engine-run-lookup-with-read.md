---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now looks for a thread's running run while it reads the thread's state, not only after. A run it finds is joined as soon as both answer, so a thread opened while a run is going shows the run's progress, `isLoading` and the stop button a round trip sooner. The lookup after the read still runs, and only it can tell that no run is going: the thread watcher opens once the read lands and doesn't replay a run that started before it, so a lookup sent with the read can miss a run that started during the read. A thread load sends one more runs list than before.

A join queued behind another stream, such as a `joinStream()` called during a run, no longer starts once the engine has switched to another thread, and the server's queued runs stay in the queue until such a join has streamed.

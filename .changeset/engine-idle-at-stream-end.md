---
"@langchain/langgraph-sdk": patch
---

A `StreamOrchestrator` run that streamed no `values`, as with `stateKeys: []` in `@langchain/react` 2.0, now stops loading when its stream ends. The read of the thread's head such a run makes starts then and replaces what the run streamed when it lands, so an app's stop button, its composer and the next queued run no longer wait for it. The read still comes first when the head shown has interrupts, pending nodes or task errors, since the run may have answered or cleared them. It also does when a run is queued behind this one, since that run starts from what the read shows, and when `onFinish` takes the state or history is on. A read that lands after another run began, a thread switch or a stop that changed the values changes nothing shown. An `onFinish` that takes no state is now called when such a run's stream ends, without the head, and still before `onRunEnd`.

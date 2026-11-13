---
"@langchain/langgraph-sdk": patch
---

A `stop()` right after a `submit()`, in the same tick, now stops it. The stop came before the submit's stream began and was lost, so the run was created and streamed to the end. Now the stream begins stopped: `StreamOrchestrator` and the `useStream` hook from `@langchain/langgraph-sdk/react` send nothing, and `CustomStreamOrchestrator` gives its transport an aborted signal. A `switchThread()` right after a submit drops it the same way, where `StreamOrchestrator` sent it to the new thread.

`StreamOrchestrator` calls `onRunEnd` with `reason: "stopped"` and no `runId` for a submit stopped before its run's id came, so `runId` is optional in `onRunEnd`'s type.

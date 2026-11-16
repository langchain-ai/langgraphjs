---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` no longer takes the frames of a run `@langchain/react` 1.x started for its state. A page that moved to `@langchain/react` 2.0 while such a run went on joined it, by opening its thread, by joining a run 1.x queued, or when its thread watcher saw the run start. On the Agent Server its messages then went away until the run ended. On the JS dev server it stopped loading before the run ended and missed the run's last message until a reload.

Now such a run's join reads only its `metadata`, `error` and `end` events. The page keeps what it showed and stays loading until the run ends, then shows the thread's state. A subagent panel open meanwhile reads its history instead of joining the run. These runs are told apart by the run the engine lists or reads before it joins, with no other request.

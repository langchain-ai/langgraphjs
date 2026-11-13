---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` calls `onCreated` for each run a submit queued on the server, as the run starts streaming and after the run before it called `onRunEnd`. A submit made during a run never called `onCreated` before. A queued submit cancelled before its run started never does, and runs other clients queued don't, as before.

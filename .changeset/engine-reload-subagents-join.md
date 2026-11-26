---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` with `scopedSubagents` now lists the subagents of a run it joins from a loaded head on a server that filters a join by namespace and sends lifecycle events (`stream_namespaces` and `stream_lifecycle`). A page reloaded while such a run's subagents ran listed none of them until the run ended, so `useMessages(stream, subagent)` in `@langchain/react` showed nothing for the rest of the run. A subagent's messages now stream after the reload as they do live.

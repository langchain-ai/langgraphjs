---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now updates its subagents when it reads a thread again. A subagent whose `task` result was saved by a run the page didn't stream, such as when another tab answered its interrupt, now ends with that result or error instead of staying `"running"`, and subagents another tab started are listed. Before, a later read of the same thread changed no subagent once any was listed. `useStream` from `@langchain/langgraph-sdk/react` gets the same fix. `StreamManager.reconstructSubagents` no longer takes `skipIfPopulated`.

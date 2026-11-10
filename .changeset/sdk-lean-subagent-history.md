---
"@langchain/langgraph-sdk": patch
---

After a reload, `useStream` now requests only checkpoints and tasks from `/history` to match subagents to their cards. The Python Agent Server 0.17.0 and later then leaves out the thread's values, so on a 20-turn thread the response drops from 55 MB to 298 KB. Subagent cards also no longer show another subagent's messages, or none, when another tool call in the same AIMessage was answered before the subagents started, for example one a human rejected. JS graphs need `@langchain/langgraph` 1.7.2 or later for that case. On older versions, unfinished subagents from that step show no messages after a reload.

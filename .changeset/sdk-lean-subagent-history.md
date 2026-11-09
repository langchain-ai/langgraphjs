---
"@langchain/langgraph-sdk": patch
---

Fixed subagent cards in `useStream` showing another subagent's messages, or none, after a reload. This happened when another tool call in the same AIMessage was answered before the subagents started, for example one a human rejected. On the Python Agent Server 0.17.0 and later, the reload request no longer includes the thread's values. JS graphs need `@langchain/langgraph` 1.7.2 or later for the human-in-the-loop case. On older versions, unfinished subagents from that step show no messages after a reload.

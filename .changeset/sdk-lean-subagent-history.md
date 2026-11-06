---
"@langchain/langgraph-sdk": patch
---

After a reload, a subagent card from `useStream` no longer shows another subagent's messages, or none, when another call in the same AIMessage was answered before the subagents started, for example because a human rejected it. `useStream` now requests the `/history` page it matches subagents from with `select: ["checkpoint", "tasks"]`, so the Python Agent Server 0.17.0 and later leaves out the thread's values. In a JS graph where human-in-the-loop paused on a call in the same AIMessage as subagent calls, unfinished subagents from that step are left unmatched after a reload.

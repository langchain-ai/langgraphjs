---
"@langchain/langgraph-sdk": patch
---

After a reload, `useStream` matches subagent cards to their subagents from a `/history` page requested with `select: ["checkpoint", "tasks"]`, reading only task results. The Python Agent Server (`langgraph-api` 0.18.0 and later) then leaves the thread's values out of that page; servers that don't know `select` send full pages, which match the same way. The `useStream` hooks from `@langchain/react` and `@langchain/langgraph-sdk/react` now share this matching, and a card no longer shows another subagent's messages, or none, when a call in the same AIMessage was answered before the subagents started, for example because a human rejected it. Known limit: in a JS graph where human-in-the-loop paused on a call in the same AIMessage as subagent calls, unfinished subagents from that step can be left unmatched, or matched to the wrong subagent, after a reload. `client.threads.getHistory` already accepts `select`.

---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` shows no `{ when: "breakpoint" }` interrupt while a thread's load looks for its running run. When the load found a run in progress, that placeholder showed until the join started, with no id to answer it by.

---
"@langchain/langgraph": patch
---

Resuming a subgraph after some of its parallel interrupts were answered no longer reruns the nodes and `task()` calls that already finished: a nested graph replays its finished tasks only while it is time traveling, and otherwise treats a resume the way a top-level graph does.

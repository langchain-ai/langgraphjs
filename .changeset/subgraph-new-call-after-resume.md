---
"@langchain/langgraph": patch
---

A `checkpointer: true` subgraph that its parent calls again in the first step after resuming, such as past an `interruptBefore` or `interruptAfter` breakpoint, now runs on its new input instead of returning its previous call's output. A subgraph call that paused or failed still resumes where it stopped.

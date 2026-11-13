---
"@langchain/langgraph": patch
---

The Pregel loop finds `DeltaChannel` and `UntrackedValue` channels once per run instead of scanning every channel on each task and step. A 1,000-node chain runs 1.37x faster.

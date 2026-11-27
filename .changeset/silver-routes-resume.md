---
"@langchain/langgraph": patch
---

Finish state and routing writes together when a parallel node fails, so resuming a checkpoint preserves conditional, Command, and static successors without rerunning completed nodes.

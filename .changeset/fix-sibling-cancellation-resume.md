---
"@langchain/langgraph": patch
---

Prevent framework sibling cancellation from being persisted as a node failure or routed to a node's `errorHandler`, so unfinished tasks can rerun on checkpoint resume after another parallel task fails.

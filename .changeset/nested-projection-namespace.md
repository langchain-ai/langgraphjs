---
"@langchain/langgraph-sdk": patch
---

Keep nested `messagesProjection` and `valuesProjection` from applying a child subagent's `values` snapshots, which replaced the parent's messages and state while the child ran.

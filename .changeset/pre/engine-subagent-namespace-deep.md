---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now finds a finished subagent's namespace up to 540 checkpoints back in the thread's history, when the subagent's tool message doesn't record it (`artifact.checkpoint_ns`). It read only the newest 40, so after a page reload `useMessages(stream, subagent)` in `@langchain/react` showed only the subagent's task and result, not its own steps, once a later turn or a few more model calls of an agent with middleware had followed it. It now reads up to five more pages of 100.

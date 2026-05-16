---
"@langchain/langgraph-sdk": patch
---

Bind deepagents subagent discovery to the execution namespace via taskInput so `useMessages(stream, subagent)` resolves the streaming scope instead of the trigger tool-call namespace.

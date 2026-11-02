---
"@langchain/langgraph-sdk": patch
---

Scope nested `messagesProjection`, `valuesProjection`, and media projections to their own namespace so a child subagent's events no longer replace the parent's messages, values, or media.

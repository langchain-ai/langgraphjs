---
"@langchain/langgraph-sdk": patch
---

Joining a run from its first event in a mount that already streamed it no longer doubles each message's text, subagent messages included. A join that resumes from a `lastEventId` still continues the message where it left off.

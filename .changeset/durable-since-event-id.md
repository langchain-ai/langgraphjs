---
"@langchain/langgraph-sdk": patch
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

feat(sdk): seek SSE replay with durable since_event_id

Honor `since_event_id` on event-stream opens so reconnects skip history
the client already has. Session `since` stays for same-connection seq
resume. JS Agent Server filters sinks the same way.

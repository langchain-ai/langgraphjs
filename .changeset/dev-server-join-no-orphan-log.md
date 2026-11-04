---
"@langchain/langgraph-api": patch
---

Joining a run that doesn't exist, or that ended long enough ago that its events were dropped, now ends at once instead of after half a second, and no longer leaves an empty event log in memory. A run cancelled before it started now drops its event log two minutes later, as a run that ended does.

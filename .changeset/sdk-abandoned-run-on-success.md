---
"@langchain/langgraph-sdk": patch
---

A run abandoned by `clear()` or `stop()` no longer runs `onSuccess`, so a thread switch during a reconnect backoff no longer loads the previous thread's history.

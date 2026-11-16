---
"@langchain/langgraph-sdk": patch
---

When a `CustomStreamOrchestrator` run fails before sending `values`, the keys other than messages that its submit showed go back to what they were, or away if they were new. Its message stays. A run that sent `values` shows the transport's, and one that succeeds, pauses or is stopped without them keeps the keys as shown, since a transport needn't send `values`.

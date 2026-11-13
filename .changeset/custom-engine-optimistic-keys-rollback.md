---
"@langchain/langgraph-sdk": patch
---

When a `CustomStreamOrchestrator` run ends without sending `values`, for example one that fails at once, the keys other than messages that its submit showed go back to what they were, or away if they were new. Its message stays. A stopped run keeps them as shown, and a run that sent `values` shows the transport's.

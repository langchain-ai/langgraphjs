---
"@langchain/langgraph-sdk": patch
---

When a `StreamOrchestrator` run ends without sending `values`, such as one whose assistant doesn't exist, the keys other than messages that its submit showed at once go back to what they were, or away if they were new. Its message stays, marked `failed`. A stopped run leaves them to the stop's read of the thread, and a run that sent `values` shows the server's, as before.

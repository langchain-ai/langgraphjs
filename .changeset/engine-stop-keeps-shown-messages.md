---
"@langchain/langgraph-sdk": patch
---

After `stop()`, `StreamOrchestrator` keeps the inputs it showed that the server didn't save, after the saved messages, until the next run, a reload or a thread switch. A run stopped before the server saved its input lost that input from the page. A reply the stop cut off still goes.

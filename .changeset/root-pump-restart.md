---
"@langchain/langgraph-sdk": patch
---

Restart the root stream pump after a thread stream failure so a later `submit()`
can receive terminal lifecycle events instead of leaving `isLoading` stuck.

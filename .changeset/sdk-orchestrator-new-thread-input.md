---
"@langchain/langgraph-sdk": patch
---

In `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`), a new thread's first message shows as soon as it is submitted, as in `@langchain/react` 1.x. It showed only once `POST /threads` had created the thread.

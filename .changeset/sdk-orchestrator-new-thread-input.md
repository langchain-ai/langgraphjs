---
"@langchain/langgraph-sdk": patch
---

In `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`), a new thread's first message shows as soon as it is submitted, as in `@langchain/react` 1.x. It showed only once `POST /threads` had created the thread. A new thread's create that fails no longer leaves an unhandled promise rejection, and a submit made meanwhile creates a thread itself instead of rejecting.

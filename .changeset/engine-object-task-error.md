---
"@langchain/langgraph-sdk": patch
---

After loading a thread whose last task failed, `StreamOrchestrator` and the `useStream` hook from `@langchain/langgraph-sdk/react` show a task error the server returns as an object, `{ message, name }`, as an `Error` with that message. They showed the plain object, which reads as "[object Object]" as text and isn't an `Error`. A task error returned as a string shows as before.

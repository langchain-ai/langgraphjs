---
"@langchain/langgraph": patch
---

Keep node errors that are not `Error` instances intact. A node that throws a string no longer fails with `Cannot create property 'pregelTaskId'`, and the default `retryOn` no longer crashes on thrown objects without a `message`.

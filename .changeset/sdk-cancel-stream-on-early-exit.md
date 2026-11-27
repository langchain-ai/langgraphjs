---
"@langchain/langgraph-sdk": patch
---

Cancel the response body when a consumer stops iterating a streamed run early (`break`, `return`, or an error thrown inside `for await`). Previously `streamWithRetry` only released its reader lock, so the HTTP connection stayed open until the server ended the stream, which also delayed `onDisconnect: "cancel"` on the server. This affects `client.runs.stream()`, `client.runs.joinStream()` and the other SSE helpers built on it.

---
"@langchain/langgraph-sdk": minor
---

Add `client.http`, an `HttpClient` with `get`, `post`, `put`, `patch` and `delete` methods that send requests to any Agent Server route, like `client.http` in the Python SDK. Requests use the same URL, default headers, `onRequest` hook, timeouts, retries and errors as the other SDK clients, so routes with no dedicated method no longer need access to the protected `fetch`.

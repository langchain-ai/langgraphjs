---
"@langchain/langgraph-sdk": patch
---

Run streams reconnect when the server sends no readable `Location` header, as with the JS dev server or a CORS config that doesn't expose it. `client.runs.stream()` rebuilds the reconnect path from the run's `Content-Location`, threadless runs included, or from its thread and run id, and `client.runs.joinStream()` reconnects to its own URL. When `Content-Location` is hidden too, `onRunCreated` fires with the run id from the run's `metadata` event. Aborting a stream during the wait before a reconnect now ends it at once, not after the wait.

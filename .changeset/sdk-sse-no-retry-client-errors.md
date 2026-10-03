---
"@langchain/langgraph-sdk": patch
---

Stop the protocol SSE transport from retrying `stream/events` on 4xx responses (except 408 and 429): the stream now ends at once with the error. Protocol request errors now keep the HTTP `status` and response body `text`. The reconnect attempt counter now resets after every successful connect, so idle reconnects no longer use up `maxReconnectAttempts`.

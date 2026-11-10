---
"@langchain/langgraph-sdk": minor
---

Add `client.info()`, which reads the server's version and the features it supports (`flags`) from `GET /info`. `client.runs.stream()` and `client.runs.joinStream()` take per-call reconnect options: `maxReconnectAttempts` (with `0`, a dropped stream throws instead of reconnecting), `reconnectDelayMs`, `onReconnect` (called with `attempt`, `cause`, `lastEventId` and `delayMs`) and `onConnected`. `client.threads.joinStream()` also sends its modes as one comma-joined `stream_modes`, the only form older servers read. The `Run` type has `kwargs`.

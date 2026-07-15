---
"@langchain/langgraph-sdk": patch
---

fix(sdk): omit `since` on SSE reconnect

Protocol `seq` is connection-scoped: a new `POST /stream/events` re-numbers Redis replay from 1, so carrying the previous session's `since` filtered out the full history (heartbeats only after QUIC/idle drops). Reconnects now omit `since` and rely on durable `event_id` dedup.

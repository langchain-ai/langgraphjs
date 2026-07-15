---
"@langchain/langgraph-sdk": patch
---

fix(sdk): omit carried `since` on SSE reconnect

Protocol `seq` is connection-scoped: a new `POST /stream/events` re-numbers Redis replay from 1, so advancing `since` from observed seqs and sending it on reconnect filtered out the full history (heartbeats only). An explicit caller `since` is still honored on the initial open; reconnects omit `since` and rely on durable `event_id` dedup.

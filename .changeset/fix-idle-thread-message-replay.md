---
"@langchain/langgraph-sdk": patch
---

fix(sdk): stop re-streaming seeded messages on idle-thread submit

An idle (finished) thread defers its root SSE pump, so the first `submit()` brings it up and the transport replays the finished run from `seq=0`. The replayed `messages` channel carries no step (unlike `values`, guarded by `maxStep`), so it rebuilt each already-complete message from an empty `message-start` and re-streamed the whole turn token-by-token — a visible "messages replay" of the existing conversation. Seal the message ids seeded from the idle `getState()` snapshot so replayed deltas can't downgrade the complete tail; the seal lifts once a newer checkpoint advances the timeline or on thread rebind, and ids from the next run are never sealed.

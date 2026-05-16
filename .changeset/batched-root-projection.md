---
"@langchain/langgraph-sdk": patch
---

Coalesce `RootMessageProjection` store writes through a single `setTimeout(0)` flush so long `messages`-channel replays (on refresh, mid-run join, or rapid subagent streaming) no longer drain as a per-event microtask chain that trips React's `Maximum update depth exceeded` guard. Replaces the previous `MessageChannel`-based batching, which deferred initial-submit events past the first render and left the UI looking frozen until refresh.

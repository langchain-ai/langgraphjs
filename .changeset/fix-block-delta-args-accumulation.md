---
"@langchain/langgraph-sdk": patch
---

Fix `applyCoreEventDelta` overwriting instead of accumulating `tool_call_chunk` args when the Python v3 emitter sends argument fragments as `block-delta` events.

Each `block-delta` event carries only the latest `args` fragment. The previous implementation spread `event.delta.fields` onto the current block, so every fragment replaced the previous one instead of appending to it. Downstream, `parsePartialJson` on a bare fragment (e.g. `, "end_time":`) fails, which caused the call to be moved to `invalid_tool_calls` or dropped from `tool_calls` entirely.

The fix mirrors the existing `tool_call_chunk` handling in `applyCoreContentDelta`: when the current block is a `tool_call_chunk` or `server_tool_call_chunk` and the delta fields include an `args` string, the string is concatenated rather than replaced.

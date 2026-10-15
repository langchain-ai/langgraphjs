---
"@langchain/langgraph": patch
---

`messagesStateReducer` and `messagesDeltaReducer` store message chunks as their non-chunk class, as Python's `add_messages` does. A graph run with `streamMode: "messages"` or `streamEvents` now checkpoints the same `AIMessage` as `invoke`, without a duplicate `tool_call_chunks` copy of every tool call, and an in-place edit to `tool_calls` (for example a rejected call in `humanInTheLoopMiddleware`) is no longer undone when the thread is reloaded.

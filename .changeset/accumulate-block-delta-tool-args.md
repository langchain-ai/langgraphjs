---
"@langchain/langgraph-sdk": patch
---

Accumulate tool-call `args` across `block-delta` content-block deltas instead of overwriting them, so a streaming tool call stays in `AIMessage.tool_calls` while its arguments arrive.

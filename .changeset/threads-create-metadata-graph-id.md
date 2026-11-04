---
"@langchain/langgraph-sdk": patch
---

Stop `threads.create()` from overwriting a caller-supplied `metadata.graph_id` when the `graphId` shorthand is absent or empty, which deleted the key from the request body. `graph_id` is now written only when `graphId` actually has a value, matching the Python SDK. The shorthand still takes precedence when both are given.

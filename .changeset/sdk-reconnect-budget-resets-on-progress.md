---
"@langchain/langgraph-sdk": patch
---

A stream that reconnects now gets a fresh set of reconnect attempts each time an event arrives, as the Python SDK does, so a long stream no longer gives up at its sixth drop when every reconnect worked. A frame with only an `id:` or a `retry:` field does not count as an event.

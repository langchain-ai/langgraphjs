---
"@langchain/langgraph-sdk": patch
---

`client.runs.stream()` and `client.runs.joinStream()` called with `streamNamespaces` now drop the events outside those namespaces themselves, by the same rule as the Agent Server. A server that doesn't support the filter (an older version, or the JS dev server) sent every event before, and now gives the same events as one that does. `onToolEvent` no longer gets tool events of kinds other than `on_tool_start`, `on_tool_event`, `on_tool_end` and `on_tool_error`, which older queue workers forward for Python graphs.

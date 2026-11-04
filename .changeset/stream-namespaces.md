---
"@langchain/langgraph-sdk": minor
---

`client.runs.stream` and `client.runs.joinStream` take `streamNamespaces`, the namespaces of a run to stream (`""` is the root graph), each without the subagents it starts. Servers that support it report `stream_namespaces` in `/info`; older servers ignore it and send every event. A reconnect no longer re-sends query params its `Location` already carries, so the URL stops growing on every reconnect.

---
"@langchain/langgraph-sdk": minor
---

`client.runs.stream` and `client.runs.joinStream` take `streamNamespaces`, the conversations of a run to stream: `""` is the main agent's and `"tools:<task_id>"` a subagent's, each without the subagents it starts. Servers that support it report `stream_namespaces` in `/info`; older servers ignore it and send every event. A reconnect to a `Location` that already carries the request's query no longer adds the query params again, so the URL stops growing on every reconnect.

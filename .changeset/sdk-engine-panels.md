---
"@langchain/langgraph-sdk": minor
---

New in `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`): subagent panels that stream only while they are open.

- `scopes.acquire(namespace)` holds the scope of a subgraph, such as a subagent's panel, and returns `{ getSnapshot, subscribe, release }`. A snapshot has the subgraph's messages, as `BaseMessage` instances, and its latest values. All held scopes of a run share one join of it from its start, which the server filters to their namespaces when it can. A subagent no run is streaming is read once from the thread's history.
- `scopedSubagents: true` streams each subagent only to its scopes and keeps its messages out of the main conversation, as `filterSubagentMessages` does. Runs then stream subgraphs, queued ones too, and on a server with the `stream_namespaces` and `stream_lifecycle` flags in `/info`, a run's own stream carries only the main conversation and the subagents' lifecycle events. A joined run does the same when it was created that way. It's off by default, since `subagents` then has a subagent's status and result but not its messages on such a server: they come from its scope.
- `resolveSubagentNamespace(toolCallId)` finds a subagent's namespace after a reload, from its tool message or one small page of the thread's history.
- Panel joins wait while four of the page's engine streams are open, so `stop()` and `respond()` keep a free connection on servers that speak only HTTP/1.1, such as `langgraph dev`.

---
"@langchain/langgraph": minor
---

fix(langgraph): give messages and tools events the namespace of the graph that ran them

`messages` and `tools` stream events now carry the namespace of the graph that ran them:

- An event's namespace no longer ends with the node that made the call. Root tokens have the namespace `[]`, so with `subgraphs: true` they stream as `messages`, not `messages|model:<id>`, and a subgraph's tokens as `messages|sub:<id>`.
- Events from a model or tool called inside a `task()` belong to the graph that called the task: they stream without `subgraphs: true`, under that graph's namespace.
- Without `subgraphs: true`, events from inside subgraphs no longer stream. A subgraph node's returned messages still stream, whole, when it ends, and a node that streams its own subgraph with `streamMode: "messages"` or `"tools"` still receives that subgraph's events.
- Messages sent with `pushMessage` follow the same rules.

`streamEvents` with `version: "v3"` is unchanged.

---
"@langchain/langgraph": patch
---

List subagents declared on a tool node's tools under the `__subagents` node metadata key in `getGraph()` and `getGraphAsync()`, so graph viewers such as Studio can show which subagents a tool can run. Requires `@langchain/core` 1.3.1 or later, which leaves object metadata out of `drawMermaid()` labels.

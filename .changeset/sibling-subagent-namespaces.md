---
"@langchain/langgraph-sdk": patch
---

`SubagentDiscovery` now binds each concurrent subagent started from one tool node to its own namespace. The first subagent streams on `["tools:<id>"]` and the rest on `["tools:<id>", "1"]`, `["tools:<id>", "2"]`, and so on, but those sibling namespaces were never treated as concrete tool namespaces, so every concurrent subagent kept the first one's namespace and a UI showed the first subagent's messages for all of them.

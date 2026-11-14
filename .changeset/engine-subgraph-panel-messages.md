---
"@langchain/langgraph-sdk": patch
---

A `StreamOrchestrator` panel on a subgraph shows all of the subgraph's messages again, also those it shares with the main conversation. It left out every message the main conversation showed, so the panel of a subgraph that shares `messages` with its parent was empty once the subgraph ran. A panel on a subagent, a namespace under a `tools:` segment, still leaves them out, since deep agents' fork-mode subagents start from a copy of the main conversation's messages.

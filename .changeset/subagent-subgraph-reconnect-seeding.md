---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix(stream): reconcile subagents and subgraphs on thread reconnect

Seed deep-agent subagent cards from checkpoint messages and subgraph hosts from a single bounded `getHistory` read during `hydrate()`, so parallel fan-out discovery reappears immediately on refresh instead of waiting for SSE replay. Subagent execution namespaces are promoted through the existing guarded discovery state machine (bulk at hydrate, lazily per opened card via the selector layer). The getHistory cost is O(1) in requests regardless of fan-out width.

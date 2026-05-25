---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix(sdk): clear subgraph and subagent discovery on thread swap

Reset discovery stores in `StreamController.#teardownThread()` so starting a
new thread does not leave stale subgraph cards or subagent entries from the
previous run.

---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

`submit()` with `multitaskStrategy: "reject"` while another run is streaming now sends `"reject"` to the server instead of queuing the run, so the server's rejection reaches `onError`. Submits with no strategy are still queued.

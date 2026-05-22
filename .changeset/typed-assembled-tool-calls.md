---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix(stream): align AssembledToolCall typing with pre-v1 expectations

Make `InferToolCalls` resolve to generic `AssembledToolCall` unions, expose
sync `status`/`error` for reactive bindings, and align type tests across
React, Vue, Svelte, and Angular SDK packages.

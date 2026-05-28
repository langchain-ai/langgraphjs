---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

refactor(sdk): drop StreamSubmitOptions.command and simplify forkFrom

Remove the misleading submit({ command }) surface from protocol-v2
StreamController; HITL resume is respond() only. Accept forkFrom as a
plain checkpoint id string and align protocol-v2 servers and docs.

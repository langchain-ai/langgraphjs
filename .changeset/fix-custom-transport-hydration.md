---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/angular": patch
"@langchain/svelte": patch
---

fix(sdk): hydrate custom HttpAgentServerAdapter via transport getState

StreamController now prefers adapter getState() before client.threads.getState,
HttpAgentServerAdapter implements GET /threads/:id/state, and useStream inherits
apiUrl from the transport so hydration no longer defaults to localhost:8123.

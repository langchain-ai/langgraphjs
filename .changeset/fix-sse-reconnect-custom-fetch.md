---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix(sdk): keep SSE reconnect enabled with custom fetch

Auth/proxy fetch shims previously forced `maxReconnectAttempts: 0`, so HITL waits that lost `/stream/events` (e.g. `ERR_QUIC_PROTOCOL_ERROR`) never recovered and left `respond()`/`submit()` spinning. Fail-fast test mocks should pass `maxReconnectAttempts: 0` explicitly. Also plumbs reconnect options through framework `useStream` bindings.

---
"@langchain/langgraph-sdk": patch
---

The stream engine in `@langchain/langgraph-sdk/ui` accepts `stateKeys`, which `useStream` in `@langchain/react` 2.0 uses to load only the state keys a UI reads.

---
"@langchain/langgraph-sdk": patch
---

fix(sdk): preserve messages on interrupt values events

Add a regression test for interrupt-only `values` payloads to ensure
previously streamed messages are not overwritten when `__interrupt__` is emitted.

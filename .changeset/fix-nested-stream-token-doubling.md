---
"@langchain/langgraph": patch
---

fix(langgraph): dedupe merged callback handlers by identity

`mergeCallbacks` concatenated `handlers` and `inheritableHandlers` while
deduping `tags`, so a handler inherited by both the ambient and the explicit
config picked up an extra registration at every graph boundary. With tracing
on, a nested `streamMode: "messages"` run delivered every token twice.

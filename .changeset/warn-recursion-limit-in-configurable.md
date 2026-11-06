---
"@langchain/langgraph": patch
---

A graph now logs a warning when `recursionLimit` is passed inside `configurable`, where it has no effect, instead of silently running with the default limit.

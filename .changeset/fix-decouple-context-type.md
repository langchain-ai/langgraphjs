---
"@langchain/langgraph": patch
---

Decouple `ContextType` generic from `configurable` in `PregelOptions` so that providing a custom context type no longer incorrectly narrows the configurable parameter.

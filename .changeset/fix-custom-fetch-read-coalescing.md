---
"@langchain/langgraph-sdk": patch
---

Avoid coalescing thread reads when a custom fetch implementation is configured, so clients using different custom transports receive their own results.

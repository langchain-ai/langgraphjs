---
"@langchain/langgraph": patch
---

Trace runtime checkpoint `getTuple`, `put`, and `putWrites` operations without collecting their arguments, return values, or original errors. Preserve the saver interface and persistence scheduling.

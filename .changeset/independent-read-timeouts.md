---
"@langchain/langgraph-sdk": patch
---

Keep timeout-backed reads out of in-flight request coalescing so each client's deadline applies only to its own request.

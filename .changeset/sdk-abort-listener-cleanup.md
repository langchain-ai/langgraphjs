---
"@langchain/langgraph-sdk": patch
---

Clean up listeners on all source signals when a merged request signal aborts. This prevents listener accumulation when reusing a caller signal across requests with timeouts. Skip listener registration for already-aborted inputs and deduplicate repeated signals while preserving the first abort reason.

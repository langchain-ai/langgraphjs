---
"@langchain/langgraph-sdk": patch
---

Runs that `StreamOrchestrator.submit()` queues while another run is streaming now request the same stream modes as a direct submit. Previously the queued run was created without `streamMode`, so the server only produced `values` events for it: once the queue drained, replies arrived in one piece instead of token by token, and `updates`, `custom`, tool and message-tuple consumers received nothing.

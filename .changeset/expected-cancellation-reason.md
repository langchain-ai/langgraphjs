---
"@langchain/langgraph": patch
"@langchain/langgraph-api": patch
---

A stopped run's root error now keeps the abort reason as its `cause`, and the Agent Server aborts cancelled runs with `RunCancellation`, an `CancelReason`.

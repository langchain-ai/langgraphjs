---
"@langchain/langgraph-api": patch
---

A run created on a busy thread without a `multitask_strategy` is now queued (`enqueue`), as on the Agent Server and in the API reference, instead of being rejected with 422.

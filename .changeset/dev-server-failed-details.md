---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): the protocol's `failed` lifecycle event carries the run error's message instead of the whole error as JSON, and a refused strict resume's `reason`, `interrupt_ids` and `pending_ids`

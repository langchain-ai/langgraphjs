---
"@langchain/langgraph": patch
"@langchain/langgraph-sdk": patch
"@langchain/vue": patch
"@langchain/langgraph-api": patch
---

chore: depend on @langchain/protocol 0.0.21, which types `input.answered`, and map `input.answered` to the `input` channel in `inferChannel`. `input` subscribers now get `input.answered` as well as `input.requested`, so code that reads `data.interrupt_id` should check `event.method` first.

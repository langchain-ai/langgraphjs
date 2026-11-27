---
"@langchain/langgraph": patch
---

`messagesStateReducer` now treats an empty string message id as missing and assigns a fresh id, so two messages written with `id: ""` are both kept instead of the later one replacing the earlier one.

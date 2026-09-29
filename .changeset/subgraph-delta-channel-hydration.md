---
"@langchain/langgraph": patch
---

read a subgraph's DeltaChannel with the checkpointer the parent resolved, instead of hydrating it empty; hydrating a written DeltaChannel without a checkpointer now throws instead of returning an empty value

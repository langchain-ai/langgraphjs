---
"@langchain/langgraph": patch
---

read a subgraph's DeltaChannel with the checkpointer the parent resolved, instead of hydrating it empty; hydrating a written DeltaChannel without a checkpointer now throws instead of returning an empty value; `getState` and `getStateHistory` read a `checkpointer: true` subgraph from the namespace its run stores it under; resuming from a subgraph checkpoint returned by `getState(config, { subgraphs: true })` now applies the resume value instead of re-firing the interrupt

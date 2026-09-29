---
"@langchain/langgraph": patch
---

read a subgraph's DeltaChannel with the checkpointer the parent resolved, instead of hydrating it empty; hydrating a written DeltaChannel without a checkpointer now throws instead of returning an empty value; `getState`, `getStateHistory` and `updateState` use a `checkpointer: true` subgraph's namespace as its run stores it, so reads find its state and updates are no longer lost; resuming from a subgraph checkpoint returned by `getState(config, { subgraphs: true })` now applies the resume value instead of re-firing the interrupt

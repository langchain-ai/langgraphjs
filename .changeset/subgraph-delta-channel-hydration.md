---
"@langchain/langgraph": patch
---

read a subgraph's DeltaChannel with the checkpointer the parent resolved, instead of hydrating it empty; hydrating a written DeltaChannel without a checkpointer or config now throws instead of returning an empty value; state methods resolve the checkpointer the way a run does, so a `checkpointer: false` graph no longer writes state with a checkpointer lent through the config and has no task state in `getState`, and a `checkpointer: true` graph used as a root rejects state methods with the run's error; `getState`, `getStateHistory` and `updateState` use a `checkpointer: true` subgraph's namespace as its run stores it, so reads find its state and updates are no longer lost; resuming from a subgraph checkpoint returned by `getState(config, { subgraphs: true })` now applies the resume value instead of re-firing the interrupt

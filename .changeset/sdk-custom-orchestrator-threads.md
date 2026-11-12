---
"@langchain/langgraph-sdk": minor
---

`CustomStreamOrchestrator` (`@langchain/langgraph-sdk/ui`), the engine for custom transports:

- A submit stays on the thread the first one created, also one made while that run streams. Every submit after the first started a new thread.
- A submit keeps the values shown and shows its input at once (`optimistic: false` turns that off), instead of showing `initialValues` until the server answered. `initialValues` show until a run streams.
- A submit waiting behind a run is dropped when the thread switches or the run is stopped.
- `respond()` and `respondAll()` send answers through the transport as a resume command, and hide the answered interrupts until that run ends.
- `threadId`, `initThreadId()` and `activate()`, as on `StreamOrchestrator`. `hydrate()` rejects, and the scopes, queue and fork points are empty, since a custom transport has no thread or run routes.

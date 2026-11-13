---
"@langchain/langgraph-sdk": minor
---

`CustomStreamOrchestrator` (`@langchain/langgraph-sdk/ui`), the engine for custom transports:

- A submit stays on the thread the first one created, also one made while that run streams. Every submit after the first started a new thread.
- A submit keeps the values shown and shows its input at once, instead of showing `initialValues` until the server answered. The messages shown at once go to the transport as dicts with ids, so the server's copy replaces them, and a backend should keep those ids. `optimistic: false` shows nothing early and sends the input as passed. `initialValues` show until a run streams, and only on the first thread.
- A submit made during a run is listed in `queueEntries` until its turn. `cancelQueueItem()`, `clearQueue()`, a thread switch and `stop()` drop it before it starts.
- `respond()` and `respondAll()` send answers through the transport as a resume command, and hide the answered interrupts until that run ends. Without an id, `respond()` answers the interrupt `interrupt` shows, the first one. `respondAll()` resolves once its run starts.
- `hydrate(threadId)` switches to that thread and reads nothing, since a custom transport has no thread routes.
- `StreamEngine` is the interface a framework binding uses, and both `StreamOrchestrator` and `CustomStreamOrchestrator` implement it.

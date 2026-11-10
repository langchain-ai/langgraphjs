---
"@langchain/langgraph-sdk": minor
---

New in `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`):

- `respond(value, { interruptId? })` and `respondAll({ [interruptId]: value })` answer interrupts by id in one run, with `update`, `goto`, `config`, `metadata` and `strictResume`. Without an id, `respond` answers the newest interrupt shown. The run starts at once when nothing streams, or waits in the queue behind the run in flight, never interrupting it. Answered interrupts are hidden until that run ends, and show again if the answer can't be sent. The promise resolves once the run is created or queued.
- A submit's input shows at once, and its messages without an id get one, so the run's values replace them. A submit with its own `optimisticValues` shows only those, and `optimistic: false` turns this off.
- `queue: "local"` keeps a submit made during a run on the client and sends it when the engine is idle, instead of creating it in the server's queue.
- Interrupts carry the `namespace` they were raised in: from the run's `updates` events, or from their task's checkpoint when read from the thread's state.

A submit with `multitaskStrategy: "interrupt"` or `"rollback"` during a run now replaces that run's stream at once, as the `useStream` hook does, instead of waiting for it to end. Queued runs pass `strictResume` to the server too.

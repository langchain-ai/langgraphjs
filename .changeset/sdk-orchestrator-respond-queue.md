---
"@langchain/langgraph-sdk": minor
---

New in `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`):

- `respond(value, { interruptId? })` answers an interrupt, the newest one when no id is given, and `respondAll({ [interruptId]: value })` answers several in one run. Both take `update`, `goto`, `config`, `metadata` and `strictResume`. They ask for strict resume unless `strictResume` is `false`, so an answer to an interrupt that is no longer waiting fails its run instead of running the step again. During a run, the answer waits in the queue instead of interrupting it. An answered interrupt is hidden until its run ends, and shows again if the answer fails. The promise resolves once the run is created or queued.
- A submit's input shows at once. Input messages without an id get one, so the run's copies replace them. Passing `optimisticValues` shows those instead, and `optimistic: false` turns this off.
- `queue: "local"` keeps a submit made during a run on the client and sends it once the run ends, instead of queueing it on the server.
- Interrupts carry the `namespace` they were raised in.

A submit with `multitaskStrategy: "interrupt"` or `"rollback"` during a run now replaces that run's stream at once, as `useStream` does, instead of waiting for it to end. A submit queued behind a run now sends its `strictResume` too.

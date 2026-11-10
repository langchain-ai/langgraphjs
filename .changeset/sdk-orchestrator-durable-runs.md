---
"@langchain/langgraph-sdk": minor
---

`StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) takes new options for the run behavior of `@langchain/react`:

- `durableRuns`: runs outlive their tab (`streamResumable`, `onDisconnect: "continue"`), and after each thread load the thread's running run is joined from the loaded checkpoint. A new thread gets its id from the client and is created by its first run, and `stop()` cancels the run on the server, also a run it joined and a run whose id hasn't arrived yet. `stop({ cancel: false })` and `dispose()` leave the run going.
- `onRunEnd({ runId, reason })`, with `"success"`, `"error"`, `"interrupt"` or `"stopped"`.
- `maxReconnectAttempts`, `reconnectDelayMs`, `onReconnect`, `onConnected` and `streamIdleReconnect`, passed to every run stream and join.

It also gets `hydrate(threadId?)`, `hydrationPromise` and a StrictMode-safe `activate()`. For every user, a join of the run being submitted waits for its id, so the run doesn't stream twice, and a server-queued submit waits for that run to exist, so it can't overtake it. Runs it creates send `config.configurable.__event_streaming_v2: false`, so a thread a v3 client used streams the shape this engine reads.

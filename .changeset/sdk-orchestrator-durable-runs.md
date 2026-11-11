---
"@langchain/langgraph-sdk": minor
---

`StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) now keeps a run going when its tab closes, and picks it up again:

- Runs are created with `streamResumable` and `onDisconnect: "continue"`, and each thread load joins the thread's running run from the loaded checkpoint.
- `stop()` stops the stream at once and cancels the run on the server, also a run it picked up after a load. A run whose id hasn't arrived yet is cancelled once it does. A run the app joins with `joinStream()` keeps going, and `stop({ cancel: false })` and `dispose()` leave any run going.
- `durableRuns: false` keeps a run tied to its tab, as before this release.

New options: `onRunEnd({ runId, reason })`, with `"success"`, `"error"`, `"interrupt"` or `"stopped"`, and `maxReconnectAttempts`, `reconnectDelayMs`, `onReconnect`, `onConnected` and `streamIdleReconnect`, passed to every run stream and join. New methods: `hydrate(threadId?)`, `hydrationPromise` and a StrictMode-safe `activate()`.

A join of the run being submitted waits for its id, so the run doesn't stream twice, and a server-queued submit waits for that run to exist, so it can't overtake it. Runs it creates send `config.configurable.__event_streaming_v2: false`, so a thread a v3 client used streams the shape this engine reads, unless they send `context`, which the Agent Server doesn't take together with `configurable`.

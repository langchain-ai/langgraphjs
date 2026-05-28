---
"@langchain/langgraph": minor
"@langchain/langgraph-checkpoint": patch
---

Add node-level timeouts.

A `timeout` option is now supported on `StateGraph.addNode`, the functional API
(`task`/`entrypoint`), and the `Send` constructor. Pass a number of milliseconds
for a hard wall-clock cap, or a `TimeoutPolicy` for finer control:

```ts
import { TimeoutPolicy } from "@langchain/langgraph";

// hard wall-clock cap on each attempt
builder.addNode("agent", agentFn, { timeout: 60_000 });

// full control
builder.addNode("agent", agentFn, {
  timeout: {
    runTimeout: 60_000, // hard wall-clock cap, never refreshed
    idleTimeout: 10_000, // cap on time without observable progress
    refreshOn: "auto", // "auto" | "heartbeat"
  },
});

// per-task override
new Send("agent", state, { idleTimeout: 5_000 });
```

When a timeout fires, a `NodeTimeoutError` (carrying `node`, `kind`
(`"run"`/`"idle"`), `timeout`, `elapsed`, `runTimeout`, `idleTimeout`) is raised,
the attempt's buffered writes are dropped, and the node's `AbortSignal` is
aborted. `idleTimeout` is refreshed by observable progress (writes, custom
stream-writer calls, child-task scheduling, callback events) or an explicit
`runtime.heartbeat()` call. The timer resets per retry attempt, and
`NodeTimeoutError` is retryable under the default retry policy.

Ports langchain-ai/langgraph#7599, #7646, and #7659.

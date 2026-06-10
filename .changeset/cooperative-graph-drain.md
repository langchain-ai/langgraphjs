---
"@langchain/langgraph": minor
---

Add cooperative, between-superstep graph draining via `RunControl`.

A new `RunControl` (exported from `@langchain/langgraph`) exposes
`requestDrain(reason)` plus read-only `drainRequested` / `drainReason`. Pass it
through the new `control` option on `invoke` / `stream` / `streamEvents` (and the
functional API). It is surfaced on `runtime.control`, so nodes can read it or call
`requestDrain()` themselves, and it is propagated into subgraphs.

When a drain is requested, the Pregel loop checks the flag at the top of each
superstep (after the previous step's writes are applied and checkpointed): if more
tasks remain it saves the checkpoint and throws the new `GraphDrained` error (also
under `durability: "exit"`), so the run can be resumed later from the same config.
If the graph naturally finishes on that tick it returns normally and the caller can
inspect `control.drainRequested`. A drain requested inside a subgraph bubbles up and
stops the parent at its next boundary. Draining never cancels work that is already
running — pair it with an `AbortSignal` if you need a hard upper bound.

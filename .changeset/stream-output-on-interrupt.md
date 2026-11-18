---
"@langchain/langgraph": patch
---

fix(langgraph): resolve `run.output` to the state at the interrupt in `streamEvents` v3

When a run started with `streamEvents(..., { version: "v3" })` paused on `interrupt()`, `run.output` and `await run.values` resolved to `{ __interrupt__: [...] }` instead of the graph state. They now resolve to the last state snapshot, the same state `invoke()` returns next to `__interrupt__`. The interrupts stay on `run.interrupts`, and the `values` event that carries them is still emitted.

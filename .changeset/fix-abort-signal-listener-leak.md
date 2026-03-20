---
"@langchain/langgraph": patch
---

fix(core): prevent AbortSignal listener leak in stream() and streamEvents()

`Pregel.stream()` and `streamEvents()` called `combineAbortSignals()` but discarded the `dispose` function, leaking one abort listener on the caller's signal per invocation. Over many invocations this caused unbounded memory growth as each leaked listener retained references to its associated graph execution state.

- Use `AbortSignal.any()` on Node 20+ which handles listener lifecycle automatically via GC
- Fall back to manual listener management on Node 18, with proper `dispose()` called when the stream completes or is cancelled

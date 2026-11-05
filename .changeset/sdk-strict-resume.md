---
"@langchain/langgraph-sdk": minor
---

feat(sdk): add `strictResume`, so a server with strict resume refuses an answer to an interrupt that is no longer waiting. `client.runs.create()`, `stream()` and `wait()` send it as `strict_resume`, and `useStream`'s `submit()` passes it on. With `respond()` and `respondAll()`, the refusal is an `UnknownInterruptError` on `error` with `reason`, `interruptIds` and `pendingIds`, which `isUnknownInterruptError(error)` recognizes, and the interrupts still waiting show again.

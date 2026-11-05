---
"@langchain/langgraph-sdk": minor
---

feat(sdk): `respond()` and `respondAll()` take `strictResume`, so a server with strict resume refuses an answer to an interrupt that is no longer waiting; the refusal is an `UnknownInterruptError` on `error` with `reason`, `interruptIds` and `pendingIds`, and the interrupts still waiting show again

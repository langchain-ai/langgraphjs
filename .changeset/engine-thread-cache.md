---
"@langchain/langgraph-sdk": minor
---

`StreamOrchestrator` takes a `threadCache`, a `ThreadCache` exported from `@langchain/langgraph-sdk/ui`, that keeps what thread loads read. A thread opened again shows its last read at once while it is read again, and what the read finds replaces it as on a first open. Until then the cached head counts as one no read has confirmed: its interrupts and task errors stay hidden, its headless tool calls don't run, and `respond()`, and a `submit()` made before the read lands, wait for the load. A read that fails takes the cached thread off the screen and out of the cache. A read in flight when `clear()` is called, or one a disposed stream makes, stays out of it. The cache holds threads up to `maxBytes` characters of strings (32 M by default) and drops the ones opened least recently first. Without a `threadCache`, loads work as before.

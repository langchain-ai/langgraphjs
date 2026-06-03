---
"@langchain/langgraph-sdk": patch
---

fix(sdk): claim in-flight slot before root pump wait for enqueue

Move `#runAbort` and `isLoading` setup ahead of `waitForRootPumpReady()` so
`multitaskStrategy: "enqueue"` submits in the same tick land in `queueStore`
instead of bypassing the client queue.

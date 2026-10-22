---
"@langchain/langgraph-sdk": patch
---

fix(sdk): skip onSuccess for a run abandoned by clear() or stop()

`StreamManager` decided whether to call `onSuccess` by reading the shared
`abortRef`, which `clear()` and `stop()` replace with a fresh controller right
after aborting the old one. A run abandoned by either call, whose stream then
ended normally (as `streamWithRetry` does when the abort lands during its
reconnect backoff), saw the fresh controller as not aborted and ran `onSuccess`
anyway. In `useStream` this refetched the previous thread's history into the
thread now on screen after a thread switch. The run now checks its own
controller.

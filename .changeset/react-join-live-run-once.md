---
"@langchain/react": patch
---

`joinStream(runId)` now does nothing when `runId` is the run the hook is already streaming (from `submit()` or an earlier join) or has queued, and returns that stream's promise instead. Previously the second join waited for the current stream to end and then replayed the whole run, causing a second loading phase and another history refetch. This made app-level joins after `reconnectOnMount`, or of the hook's own submitted run, unsafe.

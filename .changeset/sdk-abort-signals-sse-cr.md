---
"@langchain/langgraph-sdk": patch
---

fix(sdk): stop retrying cancelled requests, release abort listeners and emit CR-terminated SSE lines at once

- A request cancelled with an `AbortSignal` or `timeoutMs` is no longer retried. Native `AbortError` and `TimeoutError` exceptions were retried with backoff, so calling `stop()` before the server answered kept `isLoading` on for 15 to 30 seconds.
- A request with a timeout no longer leaves an abort listener on the caller's signal, so reusing one signal for many requests stops piling up listeners. Runtimes without `AbortSignal.any` (Safari before 17.4, Node before 20.3) still hold one listener per request until its timeout fires or it is cancelled.
- The SSE decoder emits a line ending in a bare CR as soon as it arrives instead of holding it until the next chunk, and no longer drops the blank line of a stream that ends with CR.

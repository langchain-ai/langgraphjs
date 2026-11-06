---
"@langchain/langgraph-sdk": patch
---

fix(sdk): catch `useStream` up with the server when a tab comes back

When the page becomes visible again or the browser goes back online, a stream that dropped or was never opened (a finished thread) now checks the thread. It reads the thread without its values and reloads only when the thread moved on, reopening a stream the transport gave up on. Cards answered in another tab are removed once that run ends, and when the server says a card was already answered. A tab that loads a thread right after a run started now follows that run. `StreamController.resync()` reloads on demand after writes made outside the stream.

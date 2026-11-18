---
"@langchain/react": minor
---

`useStream` takes a `threadCache`, a `ThreadCache` now exported from `@langchain/react`, so a thread opened again shows its last read at once while it is read again. Make one cache for the app, pass it to every `useStream` that reads the same server as the same user, and call `clear()` when they sign out. See "Showing a reopened thread at once" in the `useStream` guide.

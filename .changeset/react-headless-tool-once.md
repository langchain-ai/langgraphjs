---
"@langchain/react": patch
---

Effects replayed by StrictMode, Fast Refresh or `<Activity>` no longer run a pending headless tool twice in `useStream`; the hook now forgets which tool calls it ran only when the `threadId` option changes.

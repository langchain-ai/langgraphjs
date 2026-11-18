---
"@langchain/react": minor
---

Add `ThreadCacheProvider`. Every `useStream` and `useSuspenseStream` inside it shows a thread opened again from its last read at once, while it is read again. Wrap the part of the app whose streams read the same server as the same user, and key the provider by that user. See "Showing a reopened thread at once" in the `useStream` guide.

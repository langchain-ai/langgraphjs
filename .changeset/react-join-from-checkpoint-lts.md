---
"@langchain/react": patch
---

With `reconnectOnMount`, `useStream` now rejoins a running run once the thread state has loaded, from the loaded head's checkpoint, so a reload no longer replays the run from its start over the state it just loaded. A streamed message whose id the loaded state already holds now updates that message instead of being appended again.

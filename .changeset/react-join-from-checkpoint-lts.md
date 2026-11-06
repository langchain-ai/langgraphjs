---
"@langchain/react": patch
---

With `reconnectOnMount`, `useStream` now rejoins a running run once the thread state has loaded, from the loaded head's checkpoint, so a reload no longer replays the run from its start over the state it just loaded. A streamed message now updates the message with its id wherever it is in the list, so one the loaded state already holds, or one a `values` event moved, is not appended again or written over another.

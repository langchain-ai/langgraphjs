---
"@langchain/langgraph-sdk": patch
---

Opening a thread with recent activity no longer replays it in `useStream`. Every new stream subscription receives the thread's recent events again, and the controller applied them on top of the state it had just loaded, so `messages`, `values` and `toolCalls` rewound to earlier turns and rebuilt themselves while old tool calls flashed through running and finished. The controller now skips events produced before the checkpoint it loaded. Scoped views, such as `useMessages` on a subagent, still receive the full history.

A `submit()` sent right after opening a thread also no longer ends early. A replayed completion from an earlier run used to settle it, clear `isLoading` and fire `onCompleted` while the new run was still going.

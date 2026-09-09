---
"@langchain/langgraph-sdk": patch
---

fix(sdk): recover from a server-side thread stream drop instead of freezing

The protocol SSE transport now reconnects when the server closes the event
stream cleanly. The thread stream is open-ended, so a clean close only happens
when the server's own upstream consumer died or it is restarting; before, the
client treated it as the end of the thread and the UI froze mid-run with no
error. A connection that delivered events also resets the reconnect budget, so
long-lived pages survive repeated deploys. `maxReconnectAttempts: 0` keeps the
old end-on-close behavior.

Unsolicited server error frames (no command id) and a shared stream that gives
up reconnecting now reach `stream.error`: `ThreadStream.onError` exposes them,
`useStream` sets `error`, clears `isLoading`, and settles the in-flight
`submit()` as failed.

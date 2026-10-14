---
"@langchain/langgraph-sdk": patch
---

Stop the protocol WebSocket transport from reconnecting when the server closes the socket with 4000 plus a 4xx status (4403, 4404, 4422 and the like; 4408 and 4429 still reconnect): the event stream now ends at once with an error that carries the `status`. Other 4xxx closes still reconnect, with the `status` on the `onReconnect` cause. A WebSocket thread stream that fails for good now reaches `ThreadStream.onError`, so `useStream` sets `error` and clears `isLoading`, as it already did for SSE. A command whose send fails no longer leaves a response promise behind to be rejected later as an unhandled rejection.

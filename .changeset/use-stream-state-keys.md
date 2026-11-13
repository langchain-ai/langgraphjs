---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
---

`useStream` accepts `stateKeys`, the `values` keys your UI reads. Opening a thread then sends `select` on `GET /threads/{thread_id}/state` for those keys, the messages key, and the top-level fields the hook reads itself, so the server can skip the rest of the state. `stream.values` contains only those keys plus the messages key, after loading and while a run streams, including on a server that ignores `select`. A custom adapter's `getState` receives `{ select }`. Without `stateKeys`, nothing changes.

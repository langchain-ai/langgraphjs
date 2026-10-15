---
"@langchain/langgraph-sdk": patch
---

Tool-call args streamed as `tool-call-delta` slices are appended to the tool call, so `useStream`, scoped `useMessages`, `thread.messages`, `subgraph.messages` and `subagent.messages` show live args whether the server sends slices or the older `block-delta` snapshots. `block-delta` still replaces the args.

Delta variants the SDK doesn't recognise are now ignored. Before, one froze a scoped `useMessages` view until the run ended, left the in-flight `thread.messages` message unsettled, and crashed Node with an unhandled rejection from `subgraph.messages` or `subagent.messages`. `MessageAssembler.consume` returns `undefined` for such events.

Upgrade the SDK and its bindings before your server emits `tool-call-delta`.

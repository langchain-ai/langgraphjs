---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
---

fix(sdk, sdk-react): clear `MessageTupleManager` on `joinStream` full replay

When a network error interrupted a stream and `joinStream` reconnected
without a `lastEventId`, the server replayed events from the beginning
and `MessageTupleManager.add()` concatenated the replay onto the chunks
still held from the pre-disconnect stream — doubling the assistant's
message content (`"Hello"` → `"HelloHello"`) and corrupting streamed
tool_call args. The same doubling affected per-subagent chunk managers.

`StreamManager` now exposes `resetChunkAccumulator(existingMessages?)`
which drops chunk state (plus per-subagent chunks) without touching
`state.values`, the abort controller, or the subagent registry. When
`existingMessages` is supplied, each id is seeded with its current
index so the replay overwrites messages at their original positions
instead of appending duplicates. Both the orchestrator and the React
hook's `joinStream` now call this before `stream.start(...)` when
`lastEventId === "-1"`.

Closes https://github.com/langchain-ai/langgraphjs/issues/2028.

---
"@langchain/langgraph-sdk": minor
---

`StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) reads subagent and tool events:

- With `filterSubagentMessages`, runs ask the server for `lifecycle` events, and with `onToolEvent`, for `tools` events, when the server sends them on run streams. It reads `/info` once per client to know. `onToolEvent` fires now: runs never asked for `tools` before. A server that refuses them with a 422, such as an older one during a rollout, gets the run again without them.
- Each subagent is tied to the tool call that started it, from its `lifecycle` events or from the tool call id deepagents puts on a subagent's tokens, so subagents with the same task text no longer swap. A subagent whose graph fails shows the error at once. Subagents still open when the server says their run failed or was cancelled, or when `stop()` cancels it, end with an error. A run paused at an interrupt, a dropped connection or `stop({ cancel: false })` leaves them open.
- `onChannelEvent(listener)` hands every event of its streams to the listener in `@langchain/react` 1.x's channel shape, `{ method, params: { namespace, timestamp, data } }`. `CustomStreamOrchestrator` has it too.

In `StreamOrchestrator` and the `useStream` hook from `@langchain/langgraph-sdk/react`, when the server restarts a run (a worker stops, or a deploy outlasts the run), the main conversation drops what the cut attempt half-streamed and keeps what its finished steps wrote, instead of showing both. A subagent card that only the cut attempt's message started goes too.

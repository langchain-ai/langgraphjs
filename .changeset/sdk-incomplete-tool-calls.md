---
"@langchain/langgraph-sdk": minor
---

`ToolCallStatus` has a fourth value, `"incomplete"`: the call has no result, and no run can still give one, because the run stopped, failed, or waits on an interrupt, or a later message closed the call's turn. `seedToolCallsFromMessages` gives it to such calls. Pass `{ isLoading: false }` when no run streams. It defaults to `true`, which leaves the calls of the latest turn `"running"` as before. Calls assembled from `tools` events don't get it. On 1.x bindings, a subagent panel loaded from history now shows an earlier turn's unanswered call as `"incomplete"`. Code that switches over every `ToolCallStatus` needs a case for the new value.

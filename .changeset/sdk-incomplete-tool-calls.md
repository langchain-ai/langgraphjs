---
"@langchain/langgraph-sdk": patch
---

`ToolCallStatus` has a fourth value, `"incomplete"`: the call has no result, and no run streams that could give one, because the run stopped, failed, or waits on an interrupt. `seedToolCallsFromMessages` gives it to calls with no `ToolMessage` when passed `{ isLoading: false }`, and while a run streams to calls whose turn a later message closed, so a UI can stop showing them as running. Without the option they stay `"running"` as before. Code that switches over every `ToolCallStatus` needs a case for the new value.

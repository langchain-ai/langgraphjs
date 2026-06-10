---
"@langchain/langgraph": minor
---

feat(ToolNode): forward graph state to tools via `runtime.state`

`ToolNode` now forwards its input to each tool through the second argument as `runtime.state`. When using `ToolNode` as a node in a LangGraph graph, this gives tools access to the current graph state for workflows that need tool-call support in LangGraph proper. Tools can type the second parameter as `ToolRuntime<StateType>` from `@langchain/core/tools` and read `runtime.state` directly. This works in every runtime, including web browsers, and removes the need for `getCurrentTaskInput()` (which relies on `node:async_hooks`/`AsyncLocalStorage`). `getCurrentTaskInput(config)` continues to work for backwards compatibility.

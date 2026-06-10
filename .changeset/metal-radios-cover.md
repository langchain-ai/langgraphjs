---
"@langchain/langgraph": minor
---

feat(ToolNode): forward graph state to tools via `runtime.state`

`ToolNode` now forwards its input (the current graph state when used as a graph node, e.g. in `createReactAgent`) to each tool through the second argument as `runtime.state`. Tools can type the second parameter as `ToolRuntime<StateType>` from `@langchain/core/tools` and read `runtime.state` directly. This works in every runtime, including web browsers, and removes the need for `getCurrentTaskInput()` (which relies on `node:async_hooks`/`AsyncLocalStorage`). `getCurrentTaskInput(config)` continues to work for backwards compatibility.

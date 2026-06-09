---
"@langchain/langgraph": minor
---

feat(ToolNode): forward graph state to tools via `config.state`

`ToolNode` now forwards its input (the current graph state when used as a graph node, e.g. in `createReactAgent`) to each tool through the second argument as `config.state`. Tools can type the second parameter as the new `ToolRunnableConfig<StateType>` and read `config.state` directly. This works in every runtime, including web browsers, and removes the need for `getCurrentTaskInput()` (which relies on `node:async_hooks`/`AsyncLocalStorage`). `getCurrentTaskInput(config)` continues to work for backwards compatibility.

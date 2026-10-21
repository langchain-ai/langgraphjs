---
"@langchain/langgraph": patch
---

Fix `ToolNode` turning a `Command.PARENT` handoff raised by a graph invoked inside a tool into an error `ToolMessage`. `ToolNode` now re-throws every graph bubble-up signal (`GraphInterrupt`, `ParentCommand`, ...) even when `handleToolErrors` is enabled, matching the Python `ToolNode`.

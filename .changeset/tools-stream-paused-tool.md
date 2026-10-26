---
"@langchain/langgraph": patch
---

fix(langgraph): stop reporting a paused tool as failed on the tools stream

A tool that calls `interrupt()`, or whose run is drained, no longer emits `on_tool_error` on the `tools` stream mode. The tool is paused, not failed: on resume it runs again and emits `on_tool_start` and `on_tool_end`. `ToolNode` now re-throws a drain, as it already did an interrupt, instead of turning it into an error `ToolMessage`.

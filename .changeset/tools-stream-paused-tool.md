---
"@langchain/langgraph": patch
---

fix(langgraph): stop reporting an interrupted tool as failed on the tools stream

A tool that calls `interrupt()` no longer emits `on_tool_error` on the `tools` stream mode. The tool is paused, not failed: on resume it runs again and emits `on_tool_start` and `on_tool_end`.

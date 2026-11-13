---
"@langchain/langgraph-sdk": patch
---

A subagent rebuilt from a loaded thread's messages takes its namespace from its `task` tool message when the message records it (`artifact.checkpoint_ns`, which Python deepagents write), with no request. Before, its `namespace` stayed empty until something looked it up in the thread's history.

A subagent the main agent called has `depth: 1` also before it runs and after a reload, where it had `0`. Once its events streamed, it already had `1`.

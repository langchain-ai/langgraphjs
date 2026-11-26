---
"@langchain/react": patch
---

A tool call with no result shows as `"incomplete"` once no run can answer it: after its run stopped or failed, while its run waits on an interrupt, and while a later turn runs. It shows as `"running"` while a run streams its turn, while a thread load hasn't ruled out a run still going, including a thread `ThreadCacheProvider` shows at once, and while the page runs it as a headless tool. A subagent's tool calls show as `"running"` only while the main conversation's `task` call that started it, or the subagent it's nested in, does. Tool calls keep their identity when only whether a run is streaming changes.

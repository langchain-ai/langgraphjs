---
"@langchain/react": patch
---

A subagent in `stream.subagents` with no result shows the new status `"incomplete"` once no run streams that could give it one: on a loaded thread whose run ended before the subagent returned, while a later turn runs, while its run waits on an interrupt, and after `stop({ cancel: false })`. It showed `"running"` for good. A subagent with no result takes its `task` tool call's status, so a run that resumes it makes it `"running"` again, and a later read of the thread that has its result makes it `"complete"`.

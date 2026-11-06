---
"@langchain/langgraph": patch
---

`getState` and `getStateHistory` report the `result` of a task that was interrupted and then resumed. The task's interrupt write stays on the checkpoint after it finishes, and that hid the result, so a node with human-in-the-loop never showed what it returned in history. A task that failed after writing some output now reports that output as its `result` too, as in Python. A task still paused at an interrupt keeps `result: undefined`.

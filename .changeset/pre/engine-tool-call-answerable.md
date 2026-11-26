---
"@langchain/langgraph-sdk": minor
---

`StreamEngine` tells a binding whether a run can still answer a tool call that has no result. `headUnconfirmed` is `true` while a thread load hasn't ruled out a run still going on the head it shows, or that head came from the thread cache, the window in which `interrupts` stays hidden. `runsHeadlessTools` is `true` from when the page starts a headless tool until the run its result resumes starts. `newTurnAfter` is the id of the last message shown when the streaming run started a new turn whose input wasn't shown yet. A run joined from the server's queue, a thread load or another tab counts when its input's message ids are missing from what's shown. `seedToolCallsFromMessages` takes `newTurnAfter` as an option and marks the calls up to that message `"incomplete"`.

---
"@langchain/langgraph-sdk": minor
---

`StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) now follows its thread between `activate()` and dispose:

- A run started elsewhere, such as in another tab or by a cron, is joined and streams here. A run that ended elsewhere reads the thread again, and an interrupt answered elsewhere is hidden at once.
- It keeps one connection to the thread's `lifecycle` stream, closed while a run streams here, while the queue holds runs and while the page is hidden, and it resumes from the last event it saw. On a server without a thread stream it stays off after one request.
- `watchThread: false` turns it off.

Each thread load also lists the thread's queued runs, so a run queued before a reload shows in the queue again and streams when its turn comes. The queue now also moves on when a joined run ends.

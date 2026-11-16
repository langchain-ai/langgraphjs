---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now shows a run that ran on its thread while the page was hidden, also when its thread watcher had no event to resume from. The watcher closes while the page is hidden and resumes from its last event when the page shows again. It takes event ids only from the thread's stream, and the page's own runs stream on their run's stream, so a watcher that has seen no run started elsewhere has none. Its stream then started live, and a run another tab, a cron or a trigger ran meanwhile showed only after a reload. Now such a watcher reads the thread's state once as the page shows again, as after a `gap`. A watcher with an event id resumes from it as before.

---
"@langchain/langgraph-sdk": patch
---

`CustomStreamOrchestrator` no longer resumes the wrong thread with a headless tool's result. When the page switched threads while a headless tool ran, the result resumed the thread switched to, with the first thread's command. The result is now dropped, as `StreamOrchestrator` already drops it.

---
"@langchain/langgraph-sdk": patch
---

Match streamed lifecycle terminals to the run returned by `run.start`, so replayed events from older runs do not complete a new local submission.

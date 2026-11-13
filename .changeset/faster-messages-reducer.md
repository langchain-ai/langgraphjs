---
"@langchain/langgraph": patch
---

`messagesStateReducer` does less work per update on a long history: it rules out message chunks with a native prototype check first, looks up only the ids the update touches, and skips the removal pass when nothing is removed. A call on 2,000 messages is 4x faster.

---
"@langchain/langgraph-sdk": patch
---

fix(sdk): `submit()` without a `multitaskStrategy`, while the thread shows a run in flight, now sends `interrupt`, so the server cancels the run the client stopped following instead of queueing the new one behind it. Otherwise it still sends only a strategy the caller passed.

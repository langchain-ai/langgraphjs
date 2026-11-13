---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` creates the runs of submits made during a run one after another, in submit order. It sent each create at once, so the server could queue, and run, them in the order the requests arrived. A create that fails doesn't hold back the next one, and `clearQueue()` or a thread switch drops the submits still waiting for theirs. A queued run whose create returns after the run before it ended now streams too, instead of waiting for the next run to end.

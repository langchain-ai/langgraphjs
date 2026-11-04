---
"@langchain/langgraph-sdk": patch
---

Type the `end` event that closes a run stream as `EndStreamEvent`: its data carries the run's `run_id` and final `status`, or is `null` from servers that send it without data.

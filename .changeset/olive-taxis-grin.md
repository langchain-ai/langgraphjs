---
"@langchain/langgraph-checkpoint": patch
---

Keep `uuid6` monotonic when the wall clock steps backwards. The overflow branch already pinned the timestamp to the last value used, but the ordinary same-millisecond branch passed the current reading straight through, so a clock regression produced a checkpoint id that sorted before its predecessor and savers resolved an older checkpoint as the latest one.

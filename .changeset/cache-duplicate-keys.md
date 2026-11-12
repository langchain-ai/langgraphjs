---
"@langchain/langgraph": patch
---

Tasks with the same cache key in one step are now all served from the cache. Before, the cache was asked for the key once per task but only the last task received the writes, once per ask: a fan-out of `Send`s with the same input to a cached node wrote an extra result on a cached run, and an entrypoint calling a cached task twice with the same input failed with `BUG: multiple returns found for task`.

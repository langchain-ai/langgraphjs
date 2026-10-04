---
"@langchain/langgraph": patch
---

fix(langgraph): run all tasks when maxConcurrency is 1

The runner's scheduling loop exited as soon as its only in-flight task settled, silently dropping every remaining task in the superstep. Keep scheduling while unstarted tasks remain, so `maxConcurrency: 1` executes the full fan-out sequentially.

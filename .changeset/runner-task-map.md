---
"@langchain/langgraph": patch
---

The runner keeps a step's running tasks in a `Map`. Listing them took longer with every task, which made wide `Send` fan-outs quadratic: 500 parallel tasks now run 1.4x faster.

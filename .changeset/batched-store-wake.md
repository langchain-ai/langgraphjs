---
"@langchain/langgraph-checkpoint": patch
---

The batched store a compiled graph wraps around its store now wakes when a call is queued instead of polling a 0 ms timer, which Node clamps to 1 ms. Store calls made from a node no longer wait about 1 ms each: a loop doing one `get` and one `put` per step runs 10.9x faster.

---
"@langchain/langgraph": patch
---

fix(langgraph): list an interrupt raised in a subgraph once in `streamEvents` v3

`run.interrupts` listed one `interrupt()` once per graph level: twice for a subgraph, three times for a subgraph inside a subgraph. It now lists it once, matching `invoke()` and `getState()`.

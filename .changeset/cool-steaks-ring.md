---
"@langchain/langgraph": patch
---

fix(core): time travel replay/fork for graphs with interrupts and subgraphs

Ports Python fixes for stale RESUME writes during replay, wrong subgraph checkpoint loading during time travel, missing fork checkpoints on replay, and direct-to-subgraph time travel.

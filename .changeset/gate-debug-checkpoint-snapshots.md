---
"@langchain/langgraph": patch
---

perf(core): skip debug checkpoint snapshots when not streaming them

Avoid building full-state `mapDebugCheckpoint` payloads on every tick when
no consumer subscribed to `checkpoints` or `debug` stream modes. v3
companion checkpoint envelopes are unchanged (they come from values metadata).

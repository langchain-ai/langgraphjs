---
"@langchain/langgraph": patch
---

fix(core): keep stream chunks as three-element tuples

Emit lightweight checkpoint envelopes as separate
`[namespace, "checkpoints", envelope]` chunks before paired `values` chunks.
Public `stream()` always yields `[namespace, mode, payload]`; the v3
protocol path surfaces envelopes via `convertToProtocolEvent`.

---
"@langchain/langgraph": patch
---

fix(core): keep stream() on Python 3-tuple shape

langgraph >=1.3 attached an optional 4th `StreamChunkMeta` element to
subgraph stream tuples for the native v3 protocol stream. That element was
also emitted on plain `stream()` and legacy `streamEvents(v2)`, which
breaks consumers expecting Python's `[namespace, mode, payload]` shape
(e.g. the managed runtime unpacking JS `on_chain_stream` chunks). Gate
the 4th element on `version: "v3"` only.

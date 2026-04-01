---
"@langchain/langgraph": minor
---

Add the in-process event streaming runtime behind `streamEvents`.

LangGraph now exposes the core primitives for event-based streaming, including
`StreamChannel`, `StreamMux`, `GraphRunStream`, `SubgraphRunStream`, native
stream transformers, and protocol event conversion utilities. These APIs let
graphs emit ordered protocol events, derive additional projections, expose
custom stream channels, and bridge in-process runs to remote SDK clients.

The runtime includes built-in transformers for messages, values, lifecycle
events, and subgraph discovery. It also adds support for transformer
registration during graph execution, forwarding remote `StreamChannel` output,
subgraph-aware event routing, event log multiplexing, and checkpoint-aware
values streams.

This release also expands test coverage across Pregel streaming, event
conversion, stream muxing, stream channels, run streams, lifecycle
transformers, subgraph transformers, and type-level streaming behavior.

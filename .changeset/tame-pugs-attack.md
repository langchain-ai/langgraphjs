---
"@langchain/langgraph": minor
---

Add `StateGraph.setNodeDefaults()` for setting graph-wide node policy defaults (`retryPolicy`, `cachePolicy`). Per-node values passed to `addNode` always take precedence, and defaults are resolved at `compile()` time so call order does not matter. Defaults are not inherited by subgraphs. Ports Python's `set_node_defaults()` (langchain-ai/langgraph#7747).

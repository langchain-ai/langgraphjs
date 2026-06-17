---
"@langchain/langgraph": patch
---

fix(langgraph): recognize JSON-erased `Overwrite` values across runtimes

`Overwrite` already survives JSON serialization in JS because `Overwrite.toJSON()`
emits the canonical `{ "__overwrite__": value }` sentinel. `_getOverwriteValue`
now additionally recognizes the discriminator form `{ "type": "__overwrite__",
value }` produced when a typed `Overwrite` from another runtime (e.g. a Python
dataclass routed through the LangGraph API server) is serialized and its type is
erased. This keeps `Overwrite` (and `DeltaChannel`) semantics intact across
cross-runtime JSON boundaries. These delta-channel APIs remain Beta.

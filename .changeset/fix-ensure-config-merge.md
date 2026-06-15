---
"@langchain/langgraph": patch
---

fix(langgraph): merge instead of overwrite in `ensureLangGraphConfig`

`ensureLangGraphConfig` now per-key merges `callbacks`, `tags`, `metadata`,
and `configurable` across configs instead of last-write-wins, so values
bound via `.withConfig({...})` survive when a later (e.g. invoke-time)
config supplies other keys. The merged dicts are fresh objects, fixing a
by-reference mutation of shared base configs. Also drops the now-redundant
`combineCallbacks` workaround in `streamEvents`, which double-registered and
double-fired graph-bound callbacks.

---
"@langchain/langgraph-sdk": patch
---

fix(sdk): apply in-place message metadata updates from values

Same-id `values` snapshots that mutate nested metadata (e.g. HITL card
`status: accepted → done`) without changing content were treated as no-ops
because enrichment only accepted shallow key-supersets. Prefer values when
they retain every nested key and only mutate leaves or add keys, so
`useStream().values` reflects the update.

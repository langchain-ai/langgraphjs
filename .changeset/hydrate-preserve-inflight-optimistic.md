---
"@langchain/langgraph-sdk": patch
---

fix(sdk): keep optimistic messages when submit races hydrate

`hydrate` drops unpersisted optimistic messages after `getState()` so reloads
converge to server truth. A submit that starts while that fetch is in flight
adds a message the snapshot cannot contain; dropping it treats a live write as
never-persisted. Snapshot `#submitGeneration` before the fetch and skip the drop
when a newer submit has started — the same generation guard already used for
interrupt-allowlist seeding a few lines below.

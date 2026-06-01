---
"@langchain/langgraph-checkpoint-redis": patch
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph-api": patch
"@langchain/langgraph": patch
"@langchain/langgraph-supervisor": patch
"@langchain/langgraph-sdk": patch
---

chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

`uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

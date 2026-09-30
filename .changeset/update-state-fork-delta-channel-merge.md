---
"@langchain/langgraph": patch
---

fix(langgraph): isolate DeltaChannel state in updateState forks

`updateState` persisted its channel writes under the parent checkpoint,
which parallel branches forked from the same root (e.g. the empty
`ffff-` root) share. DeltaChannel state reconstruction walks the ancestor
chain and replays every pending write stored under that checkpoint id, so
the writes of all sibling branches were merged into each branch's state
(#2737).

Delta channels written by `updateState` are now force-snapshotted into the
new branch checkpoint (terminating the ancestor walk there) and their
pending writes are no longer persisted under the shared parent. The
snapshotted channel's version is also bumped past the thread head's
version, because blob-based savers (e.g. PostgresSaver) key channel values
by `(thread_id, checkpoint_ns, channel, version)` with no checkpoint id —
without the bump, sibling branches would derive the same version and the
snapshot blob would be dropped by the insert's ON CONFLICT DO NOTHING.

---
"@langchain/langgraph-checkpoint-redis": patch
---

fix(checkpoint-redis): `RedisSaver.getTuple()` without a `checkpoint_id` no longer runs `KEYS checkpoint:<thread_id>:<checkpoint_ns>:*`, which scans the whole database and blocks every other client of the Redis while it runs (#3264). `put()` now keeps a head pointer, the hash `checkpoint_head:<thread_id>` from each `checkpoint_ns` to its newest `checkpoint_id`, and the lookup reads that checkpoint by key. "Newest" means what it meant before: the highest `checkpoint_id`, so writing an older checkpoint again under its id leaves the pointer where it is. The pointer gets the checkpoints' TTL, `refreshOnRead` renews it, and `deleteThread()` deletes it. A thread written before this version has no pointer: its first lookup runs `KEYS` once and sets it. A pointer to a checkpoint that is gone is replaced the same way.

Upgrade note: a process on an earlier version writes checkpoints without moving the pointer. During a rolling upgrade, a thread that such a process continues keeps its pointer at the last checkpoint a process on this version wrote, and a process on this version resumes the thread from there. Finish upgrading every process that writes to the Redis before such threads are resumed.

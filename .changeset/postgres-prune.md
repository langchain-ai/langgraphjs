---
"@langchain/langgraph-checkpoint-postgres": minor
---

`PostgresSaver.prune(threadIds, { strategy })` removes old checkpoints from threads, ported from langgraph (Python)'s `PostgresSaver.prune`. `"keep_latest"` (the default) keeps the latest checkpoint of each namespace with its pending writes and the blobs it references, and deletes the rest, including the blobs only the deleted checkpoints used. A subgraph call's namespace is deleted with the root checkpoint the call started from, except a `checkpointer: true` subgraph's. `"delete"` removes every checkpoint, write and blob of the threads. Each thread is pruned in its own `REPEATABLE READ` transaction, so a run appending to the thread meanwhile is safe. `"keep_latest"` throws without pruning anything if a thread uses a `DeltaChannel`, since it rebuilds its value from older checkpoints. Passing a single string instead of an array throws, and an empty array does nothing.

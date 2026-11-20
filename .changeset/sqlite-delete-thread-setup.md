---
"@langchain/langgraph-checkpoint-sqlite": patch
---

fix(checkpoint-sqlite): create the schema in `deleteThread`

`deleteThread` was the only entry point that did not run the lazy setup, so
deleting a thread from a database that had not been written to yet failed with
`SqliteError: no such table: checkpoints` instead of being a no-op.

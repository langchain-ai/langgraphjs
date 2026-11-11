---
"@langchain/langgraph-sdk": minor
---

`StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) now keeps metadata per message id in `messageMetadataStore`:

- `parentCheckpointId` is the checkpoint to fork from to edit the message. Between `trackMessageMetadata()` and its release, the engine reads it from the thread's history whenever it is idle with messages it hasn't placed yet: after a load, and after each run back to the checkpoints it already read. It reads what each step wrote, about 1 KB a step, and the whole messages only for messages no step wrote, such as ones added with `updateState`. Messages more than about 500 steps back get none.
- `optimisticStatus` is `pending` for an optimistic message until a `values` event of its run holds it, then `sent`. A run that fails or is stopped before that marks it `failed`, and one that succeeds or pauses marks it `sent`. A reload clears it.

Every message a submit sends now carries an id, also with `optimistic: false` and for a run queued on the server. `MessageMetadataMap` and `OptimisticStatus` are exported.

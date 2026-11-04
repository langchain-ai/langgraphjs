---
"@langchain/langgraph-api": patch
---

Run streams on the dev server and the experimental embed server now end with an `end` event whose data carries the run's `run_id` and final `status`, so a client learns how the run ended without asking for the run again. `stream_mode` filters never drop it, and on the dev server a join of a run that has already ended gets just the `end` event. A rolled-back stateless run ends with `rollback`. A thread run that is deleted, as a rollback does, ends its streams without one.

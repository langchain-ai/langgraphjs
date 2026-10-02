---
"@langchain/langgraph-checkpoint-mongodb": patch
---

Rebuild `channel_values[__pregel_tasks]` when loading checkpoints written before `Checkpoint.pending_sends` was removed. The other savers gained this `v < 4` migration when the field was dropped; MongoDB did not, so resuming a legacy thread silently discarded its queued `Send`s instead of scheduling them.

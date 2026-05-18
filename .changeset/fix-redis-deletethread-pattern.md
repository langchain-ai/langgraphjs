---
"@langchain/langgraph-checkpoint-redis": patch
---

Fix `deleteThread()` using wrong key pattern (`writes:` instead of `checkpoint_write:`) and add missing cleanup of `write_keys_zset:` entries.

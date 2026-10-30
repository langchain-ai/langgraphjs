---
"@langchain/langgraph-checkpoint-redis": patch
---

`RedisSaver` no longer drops channels such as `messages` from a thread's state. Since 1.1.0, channel versions had a random fraction, and RedisJSON returns about one such float in ten with different last digits, so the checkpoint pointed at a blob key that didn't exist and the channel read back empty. Versions are now integers with a random low part: RedisJSON stores them exactly, and two branches from one checkpoint share a blob only with a one-in-a-billion chance per channel they both write. They are larger than any version an earlier release stored, so existing threads keep working. A checkpoint that already points at a changed version is not repaired.

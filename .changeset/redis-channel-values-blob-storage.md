---
"@langchain/langgraph-checkpoint-redis": patch
---

fix(langgraph-checkpoint-redis): persist and reconstruct full `channel_values` across multi-node graphs.

`RedisSaver.put()` delta-filters `channel_values` to only the channels written by the current node, but `getTuple()` had no reconstruction logic — unlike `PostgresSaver` — so any multi-node graph whose last node wrote a subset of channels silently lost the others. Each changed channel is now persisted as a version-keyed `checkpoint_blob:*` entry in `put()` and missing channels are reconstructed from those blobs on read.

`deleteThread()` now also deletes the `checkpoint_blob:*` keys. Without this the blobs introduced above would orphan forever (memory growth) and thread deletion would be incomplete, matching `PostgresSaver.deleteThread()` parity.

When `ttlConfig.refreshOnRead` is enabled, reads now refresh the TTL of the reconstructed `checkpoint_blob:*` keys alongside the checkpoint key. Otherwise a read would keep the checkpoint alive while the blobs it depends on expired, silently dropping reconstructed channels.

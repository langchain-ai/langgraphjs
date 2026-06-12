---
"@langchain/langgraph-checkpoint-redis": patch
---

fix(langgraph-checkpoint-redis): persist and reconstruct full `channel_values` across multi-node graphs.

`RedisSaver.put()` delta-filters `channel_values` to only the channels written by the current node, but `getTuple()` had no reconstruction logic — unlike `PostgresSaver` — so any multi-node graph whose last node wrote a subset of channels silently lost the others. Each changed channel is now persisted as a version-keyed `checkpoint_blob:*` entry in `put()` and missing channels are reconstructed from those blobs on read.

`deleteThread()` now also deletes the `checkpoint_blob:*` keys. Without this the blobs introduced above would orphan forever (memory growth) and thread deletion would be incomplete, matching `PostgresSaver.deleteThread()` parity.

When `ttlConfig.refreshOnRead` is enabled, reads now refresh the TTL of the reconstructed `checkpoint_blob:*` keys alongside the checkpoint key. Otherwise a read would keep the checkpoint alive while the blobs it depends on expired, silently dropping reconstructed channels.

On write, `put()` now refreshes the TTL of every blob the checkpoint references (the full `channel_versions` set), not just the channels changed by the current node, so carried-over blobs from earlier nodes expire in lockstep with the checkpoint doc. This write-side refresh is independent of `refreshOnRead`. The per-channel blob writes also now run in parallel.

Known limitation: with TTL enabled, a carried-over blob can still be lost if it expires during an idle gap longer than `defaultTTL` (no read or write refreshed it in time). When that happens the channel is left cleanly absent on read rather than erroring. Fully closing this gap (re-persisting expired blobs) is tracked as a follow-up.

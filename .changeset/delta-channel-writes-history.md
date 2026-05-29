---
"@langchain/langgraph-checkpoint": minor
"@langchain/langgraph": minor
---

Add `DeltaChannel` and the writes-history saver API (beta).

`DeltaChannel` is a reducer channel that stores only a sentinel in checkpoint
blobs instead of the full accumulated value, reconstructing state on read by
replaying ancestor writes through a batch reducer. This avoids re-serializing
the entire accumulated value at every step (e.g. long message histories).

- `DeltaChannel(reducer, { snapshotFrequency })` in `@langchain/langgraph` —
  count-based snapshot cadence (default `snapshotFrequency=1000`) plus a
  system bound `DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT` (default 5000, env
  `LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT`).
- `messagesDeltaReducer` — a batching-invariant messages reducer that coerces
  raw object/string writes, for use with `DeltaChannel`.
- `BaseCheckpointSaver.getDeltaChannelHistory({ config, channels })` (beta) —
  walks the parent chain returning per-channel `{ writes, seed? }`, with a
  direct-storage override in `MemorySaver`.
- `counters_since_delta_snapshot` added to `CheckpointMetadata`; `DeltaSnapshot`
  serialization support in the JSON+ serializer.

Reconstruction is wired through the Pregel read/execution paths (initialization,
`getState`, `updateState`, local reads) and `exit` durability accumulates and
anchors delta writes so threads remain reconstructible without forcing
snapshots.

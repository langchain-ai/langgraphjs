---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph": patch
---

fix(langgraph): make concurrent DeltaChannel writes deterministic on replay

Concurrent same-superstep writes to a `DeltaChannel` could reconstruct from a
checkpoint differently than they were applied live, because live execution
ordered them by task path while savers replayed them by task id. This fixes that
divergence in two complementary ways:

- Plain concurrent writes are now applied in the canonical `(task_id, idx)`
  order on both paths: `_applyWrites` orders them that way live, and the
  `getDeltaChannelHistory` walk enforces the same order so reconstruction
  matches live for every saver (Postgres, SQLite, MongoDB, Redis, and custom).
- An `Overwrite` now wins its entire super-step: every sibling write in the same
  step — before AND after the `Overwrite` — is discarded, matching
  `BinaryOperatorAggregate`. This makes the result independent of the (unstable)
  ordering of concurrent fan-in writes; previously a plain write that landed
  after an `Overwrite` in the same step was still folded in.

To support the per-step `Overwrite` rule, `BaseCheckpointSaver.getDeltaChannelHistory`
now returns `writes` grouped by super-step (`CheckpointPendingWrite[][]`) instead
of a flat list, and `DeltaChannel.replayWrites` applies the rule per group so a
cold read always reproduces live state. Under `"exit"` durability several
supersteps are persisted under a single anchor checkpoint, so the history walk
re-splits them by super-step (preserving step boundaries) to ensure an
`Overwrite` in one exit-mode step does not discard a later step's writes on
reload. These delta-channel APIs remain Beta.

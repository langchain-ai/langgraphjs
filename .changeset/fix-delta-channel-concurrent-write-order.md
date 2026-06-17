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

To keep reconstruction in sync with this `Overwrite` rule, any `DeltaChannel`
that sees an `Overwrite` in a super-step is now force-snapshotted at the next
checkpoint (and, under `"exit"` durability, in the final checkpoint). The
post-overwrite value is materialized into `channel_values`, so a cold read seeds
from that snapshot and never has to replay across the reset — making live and
reconstructed state identical without changing the sparse-replay history shape.
These delta-channel APIs remain Beta.

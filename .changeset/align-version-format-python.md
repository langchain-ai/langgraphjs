---
"@langchain/langgraph-checkpoint-postgres": minor
---

feat(checkpoint-postgres)!: align version format and inline primitive storage with Python

Align checkpoint version format and channel_values storage with the Python implementation:

1. **Version format:** `getNextVersion` now produces zero-padded string versions (e.g. `"00000000000000000000000000000001.0482910384729105"`) instead of integer versions (`1`, `2`, `3`).

2. **Inline primitives:** Primitive channel values (`string`, `number`, `boolean`, `null`) are now stored inline in the checkpoint JSONB column instead of in `checkpoint_blobs`.

These changes enable cross-compatibility between Python and JS checkpoint implementations sharing the same database, required for hybrid Python/JS LangGraph deployments.

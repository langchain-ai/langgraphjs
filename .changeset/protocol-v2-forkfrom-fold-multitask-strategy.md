---
"@langchain/langgraph-sdk": patch
"@langchain/langgraph-api": patch
---

protocol-v2: fold forkFrom client-side and honor per-run multitaskStrategy

The SDK now folds the ergonomic `forkFrom` option into
`config.configurable.checkpoint_id` before sending `run.start`, so the
agent server only ever accepts the single, legacy-compliant fork field
(`forkFrom` no longer hits the wire). The protocol-v2 reference servers
drop their top-level `forkFrom` normalization accordingly.

The protocol-v2 servers now honor the caller's `multitaskStrategy` per
run (one of `reject` | `rollback` | `interrupt` | `enqueue`) instead of
hardcoding it, falling back to `enqueue` when omitted or unrecognized.

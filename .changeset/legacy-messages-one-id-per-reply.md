---
"@langchain/langgraph-api": patch
---

Fix three bugs in the legacy run stream:

- In `messages` mode, each chat model reply streams under one message id. Anthropic sets the id only on a reply's first chunk, so `messages/partial` could switch to a `run-<runId>` id mid-reply that never matched the id in `messages/complete`.
- In `messages` mode with `stream_subgraphs: true`, `messages/complete` is now sent for the root graph's messages. It was never sent before.
- With `stream_subgraphs: true`, a node that streams a runnable of its own (for example a generator `RunnableLambda` called with the node's config) no longer fails the run with `TypeError: rawTuple is not iterable`, in any stream mode.

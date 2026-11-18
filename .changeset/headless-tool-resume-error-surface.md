---
"@langchain/langgraph-sdk": patch
---

Surface rejected headless-tool resume submissions through the `onTool` callback instead of swallowing them as unhandled promise rejections. When the server rejects an `input.respond` resume with a protocol error (for example `no_such_interrupt` while the targeted interrupt has not yet been committed to the durable thread row), the headless-tool result was previously dropped silently and the caller believed the submission succeeded. The failure is now reported as an `onTool` `error` event. This does not auto-retry `no_such_interrupt`, which could re-consume a genuinely already-consumed interrupt. See langchain-ai/langgraph#9164.

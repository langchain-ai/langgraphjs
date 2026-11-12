---
"@langchain/langgraph-sdk": minor
---

`@langchain/langgraph-sdk/ui` now exports:

- `SubgraphDiscovery`, with its `SubgraphDiscoverySnapshot`, `SubgraphMap` and `SubgraphByNodeMap` types. Its `push()` takes any event with a `method`, `params.namespace` and `params.data`, such as the ones `StreamOrchestrator.onChannelEvent` gives.
- `seedToolCallsFromMessages`, which builds `AssembledToolCall`s from messages, and the `AssembledToolCall` and `ToolCallStatus` types.
- `AssembledToolCallFromTool`, and `InferAssembledToolCalls`, which `@langchain/langgraph-sdk/stream` exports as `InferToolCalls`. The `InferToolCalls` that `./ui` already exports infers message tool calls and is unchanged.

`@langchain/langgraph-sdk/stream` exports the same names and types as before.

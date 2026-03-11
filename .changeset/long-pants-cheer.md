---
"@langchain/angular": patch
"@langchain/svelte": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/langgraph-sdk": patch
---

feat(sdk): convert history messages to BaseMessage instances in framework SDKs

When accessing `stream.history` in the framework SDK packages (React,
Svelte, Angular, Vue), messages within thread state values are now
converted to proper @langchain/core BaseMessage class instances (e.g.
HumanMessage, AIMessage) instead of being returned as plain objects.

The base `@langchain/langgraph-sdk` package is intentionally unchanged
and continues to return plain Message dicts for backward compatibility.

- Add `ensureHistoryMessageInstances` utility to convert messages within
  ThreadState values to BaseMessage instances
- Add `HistoryWithBaseMessages` type utility so `state.values.messages`
  is typed as `BaseMessage[]` in framework SDK history
- Update `WithClassMessages` in all four framework SDKs to remap the
  `history` property type accordingly
- Add unit tests (messages.test.ts) and type tests (stream-types.test-d.ts)
  in the base SDK verifying plain Message behavior is preserved
- Add integration tests and type tests in all four framework SDKs
  verifying BaseMessage conversion

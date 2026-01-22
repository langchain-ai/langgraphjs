---
"@langchain/langgraph": minor
---

Add type bag pattern for `GraphNode` and `ConditionalEdgeRouter` type utilities.

**New types:**
- `GraphNodeTypes<InputSchema, OutputSchema, ContextSchema, Nodes>` - Type bag interface for GraphNode
- `GraphNodeReturnValue<Update, Nodes>` - Return type helper for node functions
- `ConditionalEdgeRouterTypes<InputSchema, ContextSchema, Nodes>` - Type bag interface for ConditionalEdgeRouter

**Usage:**

Both `GraphNode` and `ConditionalEdgeRouter` now support two patterns:

1. **Single schema** (backward compatible):
   ```typescript
   const node: GraphNode<typeof AgentState, MyContext, "agent" | "tool"> = ...
   ```

2. **Type bag pattern** (new):
   ```typescript
   const node: GraphNode<{
     InputSchema: typeof InputSchema;
     OutputSchema: typeof OutputSchema;
     ContextSchema: typeof ContextSchema;
     Nodes: "agent" | "tool";
   }> = (state, runtime) => {
     // state type inferred from InputSchema
     // return type validated against OutputSchema
     // runtime.configurable type inferred from ContextSchema
     return { answer: "response" };
   };
   ```

The type bag pattern enables nodes that receive a subset of state fields and return different fields, with full type safety.

---
"@langchain/langgraph": minor
---

feat: add type utilities for authoring graph nodes and conditional edges

New exported type utilities for improved TypeScript ergonomics:

- `ExtractStateType<Schema>` - Extract the State type from any supported schema (StateSchema, AnnotationRoot, or Zod object)
- `ExtractUpdateType<Schema>` - Extract the Update type (partial state for node returns) from any supported schema
- `GraphNode<Schema, Context?, Nodes?>` - Strongly-typed utility for defining graph node functions with full inference for state, runtime context, and optional type-safe routing via Command
- `ConditionalEdgeRouter<Schema, Context?, Nodes?>` - Type for conditional edge routing functions passed to `addConditionalEdges`

These utilities enable defining nodes outside the StateGraph builder while maintaining full type safety:

```typescript
import { StateSchema, GraphNode, ConditionalEdgeRouter, END } from "@langchain/langgraph";
import { z } from "zod/v4";

const AgentState = new StateSchema({
  messages: MessagesValue,
  step: z.number().default(0),
});

interface MyContext {
  userId: string;
}

// Fully typed node function
const processNode: GraphNode<typeof AgentState> = (state, runtime) => {
  return { step: state.step + 1 };
};

// Type-safe routing with Command
const routerNode: GraphNode<typeof AgentState, MyContext, "agent" | "tool"> = 
  (state) => new Command({ goto: state.needsTool ? "tool" : "agent" });

// Conditional edge router
const router: ConditionalEdgeRouter<typeof AgentState, MyContext, "continue"> = 
  (state) => state.done ? END : "continue";
```

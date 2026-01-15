---
"@langchain/langgraph": minor
---

feat: `StateSchema`, `ReducedValue`, and `UntrackedValue`

**StateSchema** provides a new API for defining graph state that works with any [Standard Schema](https://github.com/standard-schema/standard-schema)-compliant validation library (Zod, Valibot, ArkType, and others).

### Standard Schema support

LangGraph now supports [Standard Schema](https://standardschema.dev/), an open specification implemented by Zod 4, Valibot, ArkType, and other schema libraries. This means you can use your preferred validation library without lock-in:

```typescript
import { z } from "zod"; // or valibot, arktype, etc.
import { StateSchema, ReducedValue, MessagesValue } from "@langchain/langgraph";

const AgentState = new StateSchema({
  messages: MessagesValue,
  currentStep: z.string(),
  count: z.number().default(0),
  history: new ReducedValue(
    z.array(z.string()).default(() => []),
    {
      inputSchema: z.string(),
      reducer: (current, next) => [...current, next],
    }
  ),
});

// Type-safe state and update types
type State = typeof AgentState.State;
type Update = typeof AgentState.Update;

const graph = new StateGraph(AgentState)
  .addNode("agent", (state) => ({ count: state.count + 1 }))
  .addEdge(START, "agent")
  .addEdge("agent", END)
  .compile();
```

### New exports

- **`StateSchema`** - Define state with any Standard Schema-compliant library
- **`ReducedValue`** - Define fields with custom reducer functions for accumulating state
- **`UntrackedValue`** - Define transient fields that are not persisted to checkpoints
- **`MessagesValue`** - Pre-built message list channel with add/remove semantics

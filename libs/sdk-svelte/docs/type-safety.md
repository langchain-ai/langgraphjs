## Type safety

### Agent-brand inference

Pass a graph / agent brand — `useValues`, `useMessages`, and `submit()` pick up the state shape automatically, including the tool-call union and (for DeepAgents) subagent state map:

```ts
import type { myAgent } from "./agent";

const stream = useStream<typeof myAgent>({
  assistantId: "my-agent",
  apiUrl: "http://localhost:2024",
});
```

### Custom state types

For plain state shapes, pass the state directly. The second generic slot is the interrupt type:

```ts
import type { BaseMessage } from "@langchain/core/messages";

interface MyState {
  messages: BaseMessage[];
  context?: string;
}

const stream = useStream<MyState, { question: string }>({
  assistantId: "my-graph",
  apiUrl: "http://localhost:2024",
});
```

### Typing the stream handle

Two helpers cover the most common prop shapes:

- `UseStreamReturn<T>` — the fully-resolved return type. Use for `{ stream: UseStreamReturn<typeof agent> }` props.
- `AnyStream` — a type-erased handle for helper components that only forward `stream` into selector composables.

```ts
import type { AnyStream, UseStreamReturn } from "@langchain/svelte";

// Strongly-typed parent panel
type Props = { stream: UseStreamReturn<typeof agent> };

// Generic subagent card that only forwards into selectors
type CardProps = { stream: AnyStream; subagent: SubagentDiscoverySnapshot };
```

### Type helpers

| Helper                                                                           | Use                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `InferStateType<T>`                                                              | Unwrap a compiled graph / agent brand / agent tool array into its state shape.             |
| `InferToolCalls<T>`                                                              | Derive a discriminated union of tool-call shapes.                                          |
| `InferSubagentStates<T>`                                                         | `{ name: State, … }` map derived from a DeepAgent brand.                                   |
| `WidenUpdateMessages<T>`                                                         | Widens `messages` so both wire-format and `BaseMessage` instances typecheck in `submit()`. |
| `StreamSubmitOptions<State, Configurable>`                                       | Options shape accepted by `submit()`.                                                      |
| `AgentServerAdapter` / `HttpAgentServerAdapter`                                  | Custom-transport interface + convenience class.                                            |
| `SelectorTarget` / `SubagentDiscoverySnapshot` / `SubgraphDiscoverySnapshot`     | For components that render scoped views.                                                   |
| `AssembledToolCall`, `ToolCallStatus`                                            | For rendering tool-call UI.                                                                |
| `MessageMetadata`, `UseSubmissionQueueReturn`, `SubmissionQueueEntry`            | Companion-composable return shapes.                                                        |

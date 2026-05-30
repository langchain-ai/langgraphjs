# Type safety

`@langchain/react` is designed around **agent-brand inference**: pass `typeof agent` to the hook and get typed state, tool calls, and (for DeepAgents) subagent state maps back. Plain state generics still work for graphs that aren't built with the agent helpers.

## Table of contents

- [Agent-brand inference](#agent-brand-inference)
- [Custom state types](#custom-state-types)
- [Prop-drilling the stream](#prop-drilling-the-stream)
- [Type helpers](#type-helpers)

## Agent-brand inference

Pass `typeof agent` to infer state, tool-call union, and (for DeepAgents) subagent state map:

```tsx
import type { agent } from "./agent";
import { useStream } from "@langchain/react";

function Chat() {
  const stream = useStream<typeof agent>({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  // stream.values is inferred
  // stream.toolCalls is a discriminated union of your tools
  // stream.subagents carries per-subagent state types
}
```

The same inference works on `useStreamContext<typeof agent>()` and on the companion selector hooks when you pass a scoped target:

```tsx
const messages = useMessages(stream); // BaseMessage[]
const tools = useToolCalls<typeof agent>(stream);
const state = useValues<typeof agent>(stream);
```

## Custom state types

For plain state shapes, pass the state directly. The second and third generic slots are `InterruptType` and `ConfigurableType`:

```tsx
import { useStream } from "@langchain/react";
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

## Prop-drilling the stream

Two type aliases cover the two common prop shapes:

- **`UseStreamReturn<T>`** — fully-resolved return type. Use for `{ stream: UseStreamReturn<typeof agent> }` props when the child needs typed access to state / tool calls.
- **`AnyStream`** — type-erased handle. Use when the child only forwards `stream` into selector hooks and doesn't care about the underlying state shape.

```tsx
import type { AnyStream, UseStreamReturn } from "@langchain/react";
import type { agent } from "./agent";

function ChatPanel({ stream }: { stream: UseStreamReturn<typeof agent> }) {
  // stream.values is typed here
}

function SubgraphCard({
  stream,
  subgraph,
}: {
  stream: AnyStream;
  subgraph: SubgraphDiscoverySnapshot;
}) {
  // stream is only used to feed selector hooks — no generic required
}
```

## Type helpers

| Helper                                                                                           | Use                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `InferStateType<T>`                                                                              | Unwraps a compiled graph / agent brand / agent tool array into its state shape.            |
| `InferToolCalls<T>`                                                                              | Derives a discriminated union of tool-call shapes.                                         |
| `InferSubagentStates<T>`                                                                         | `{ name: State, … }` map derived from a DeepAgent brand.                                   |
| `WidenUpdateMessages<T>`                                                                         | Widens `messages` so both wire-format and `BaseMessage` instances typecheck in `submit()`. |
| `StreamSubmitOptions<State, Configurable>`                                                       | Options shape accepted by `submit()`.                                                      |
| `AgentServerAdapter` / `HttpAgentServerAdapter`                                                  | Custom-transport interface + convenience class.                                            |
| `SelectorTarget` / `SubagentDiscoverySnapshot` / `SubgraphDiscoverySnapshot`                     | For components that render scoped views.                                                   |
| `AssembledToolCall`, `ToolCallStatus`                                                            | For rendering tool-call UI.                                                                |
| `MessageMetadata`, `UseSubmissionQueueReturn`, `SubmissionQueueEntry`, `SubmissionQueueSnapshot` | Companion-hook return shapes.                                                              |

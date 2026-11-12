# Type safety

Pass your agent's or graph's type to `useStream` and the stream is typed from it: its state, its tool calls and, for a deep agent, its subagents. Plain state types work too.

## Table of contents

- [Inference from an agent](#inference-from-an-agent)
- [Plain state types](#plain-state-types)
- [Passing the stream down](#passing-the-stream-down)
- [Type helpers](#type-helpers)

## Inference from an agent

```tsx
import type { agent } from "./agent";
import { useStream } from "@langchain/react";

function Chat() {
  const stream = useStream<typeof agent>({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  // stream.values is the agent's state.
  // stream.toolCalls is a union of the agent's tool calls.
}
```

The same works for `useStreamContext<typeof agent>()` and for `useToolCalls`:

```tsx
const toolCalls = useToolCalls<typeof agent>(stream);
```

For the main conversation's state, read `stream.values`, which is typed from the agent.

## Plain state types

For a graph without an agent type, pass the state. The second and third type parameters are the interrupts' value and the `configurable` config:

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

## Passing the stream down

- **`UseStreamReturn<T>`** is the stream typed for `T`. Use it when the child reads the typed state or tool calls.
- **`AnyStream`** accepts any stream. Use it when the child only passes the stream to selector hooks.

```tsx
import type {
  AnyStream,
  SubgraphDiscoverySnapshot,
  UseStreamReturn,
} from "@langchain/react";
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
  // stream only feeds the selector hooks, so it needs no type parameter
}
```

## Type helpers

| Helper                                                                                           | Use                                                                                            |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `InferStateType<T>`                                                                              | The state of a compiled graph or agent.                                                        |
| `InferToolCalls<T>`                                                                              | The union of the tool calls of an agent or a list of tools.                                    |
| `InferSubagentStates<T>`                                                                         | A deep agent's subagents and their states, by name.                                            |
| `WidenUpdateMessages<T>`                                                                         | Lets `submit()` take messages as plain objects or `BaseMessage` instances.                     |
| `StreamSubmitOptions`, `StreamStopOptions`, `StreamRespondOptions`, `StreamRespondAllOptions`    | The options of `submit()`, `stop()`, `respond()` and `respondAll()`.                          |
| `RunExecutionInfo`, `RunCompletedInfo`                                                           | What `onCreated` and `onCompleted` get.                                                        |
| `SelectorTarget`, `SubagentDiscoverySnapshot`, `SubgraphDiscoverySnapshot`                       | For components that show a subagent or a subgraph.                                             |
| `AssembledToolCall`, `ToolCallStatus`                                                            | For tool call UI.                                                                              |
| `MessageMetadata`, `UseSubmissionQueueReturn`, `SubmissionQueueEntry`, `SubmissionQueueSnapshot` | What the selector hooks return.                                                                |
| `Channel`, `Event`                                                                               | `useChannel`'s channels and events.                                                            |
| `ScopeHandle`, `ScopeView`                                                                       | What `subscribeScope` returns.                                                                 |

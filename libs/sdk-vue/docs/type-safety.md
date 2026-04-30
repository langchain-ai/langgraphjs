# Type safety

## Agent-brand inference

Pass a compiled agent (`typeof myAgent`) as the first generic and
everything — `values`, `toolCalls[].args`, per-subagent state — is
inferred through:

```typescript
import type { agent } from "./agent";
import { useStream } from "@langchain/vue";

const stream = useStream<typeof agent>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
// stream.values.value is typed from `agent`
// stream.toolCalls.value[0].name is the literal tool union
```

## Custom state shapes

For apps that don't work with a brand, supply the state shape
directly. The second and third generic slots are `InterruptType`
and `ConfigurableType`:

```typescript
import type { BaseMessage } from "@langchain/core/messages";
import { useStream } from "@langchain/vue";

const stream = useStream<
  { messages: BaseMessage[] },
  { question: string },           // InterruptType
  { userId: string }               // ConfigurableType
>({ assistantId: "my-graph", apiUrl: "…" });
```

## Prop-drilling the stream

When you pass the stream handle into child components, pick the
right helper type:

- `UseStreamReturn<T>` — fully-resolved return type. Use for
  `{ stream: UseStreamReturn<typeof agent> }` props.
- `AnyStream` — type-erased handle for helpers that only forward
  `stream` into selector composables.

```ts
import type { AnyStream, UseStreamReturn } from "@langchain/vue";

// Fully typed — component reads `stream.values.value`.
function ChatPanel(props: { stream: UseStreamReturn<typeof agent> }) { /* … */ }

// Type-erased — component only forwards `stream` into selectors.
function SubgraphCard(props: {
  stream: AnyStream;
  subgraph: SubgraphDiscoverySnapshot;
}) { /* … */ }
```

## Type helpers

| Helper | Use |
|---|---|
| `InferStateType<T>` | Unwraps a compiled graph / agent brand / agent tool array into its state shape. |
| `InferToolCalls<T>` | Derives a discriminated union of tool-call shapes. |
| `InferSubagentStates<T>` | `{ name: State, … }` map derived from a DeepAgent brand. |
| `WidenUpdateMessages<T>` | Widens `messages` so both wire-format and `BaseMessage` instances typecheck in `submit()`. |
| `StreamSubmitOptions<State, Configurable>` | Options shape accepted by `submit()`. |
| `AgentServerAdapter` / `HttpAgentServerAdapter` | Custom-transport interface + convenience class. |
| `SelectorTarget` / `SubagentDiscoverySnapshot` / `SubgraphDiscoverySnapshot` | For components that render scoped views. |
| `AssembledToolCall`, `ToolCallStatus` | For rendering tool-call UI. |
| `MessageMetadata`, `UseSubmissionQueueReturn`, `SubmissionQueueEntry`, `SubmissionQueueSnapshot` | Companion-selector return shapes. |

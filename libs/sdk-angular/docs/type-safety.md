# Type safety

Pass a compiled agent (`typeof myAgent`) or a plain state interface
as the first generic and everything — `values`, `toolCalls[].args`,
per-subagent state — is inferred through.

```typescript
import type { agent } from "./agent";
import { injectStream } from "@langchain/angular";

@Component({ /* … */ })
export class ChatComponent {
  readonly stream = injectStream<typeof agent>({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
  // stream.values() is typed from `agent`
  // stream.toolCalls()[0].call.name is the literal tool union
}
```

For apps that don't work with a brand, supply the state shape + an
interrupt / configurable pair manually:

```typescript
readonly stream = injectStream<
  { messages: BaseMessage[] },
  { question: string },           // InterruptType
  { userId: string }              // ConfigurableType
>({ assistantId: "my-graph", apiUrl: "…" });
```

## Generic parameters

| Position | Parameter | Inferred from |
|---|---|---|
| 1st | `StateType` | `typeof agent` or explicit interface |
| 2nd | `InterruptType` | Brand or explicit |
| 3rd | `ConfigurableType` | Brand or explicit |

Selectors pick up the same generics through the `stream` argument —
`injectValues(stream)` returns `Signal<StateType>`, no extra typing
needed.

## Public stream aliases

When you need to name a stream handle in Angular code, use
`StreamApi<T>`:

```typescript
import type { StreamApi } from "@langchain/angular";

function acceptsAngularStream(stream: StreamApi<ChatState>) {
  return stream.messages();
}
```

`StreamApi<T>` is the Angular-facing alias for the return value of
`injectStream`, `useStream`, `provideStream`, and `StreamService`.

`UseStreamResult<T>` is exported for cross-framework shared code. It is
the same shape, but matches the React naming convention:

```typescript
import type { UseStreamResult } from "@langchain/angular";

function acceptsSharedStream(stream: UseStreamResult<ChatState>) {
  return stream.values();
}
```

Prefer `StreamApi<T>` unless the type is part of a helper shared across
React, Angular, Vue, or Svelte packages.

## Why prefer `typeof agent`?

When the agent is defined with the compiled graph builder,
`typeof agent` carries:

- The exact `messages` channel shape (so `messagesKey` overrides
  typecheck)
- The literal union of tool names and their argument schemas
- Per-subagent state shapes keyed by subagent name

Picking it up via `typeof` keeps the SDK in sync with any upstream
schema change at compile time — no manual interface maintenance.

## Related

- [`injectStream`](./inject-stream.md)
- [Handling interrupts](./interrupts.md) — the `InterruptType`
  generic lines up with `stream.interrupt()`
- [Headless tools](./headless-tools.md) — tool arg / result types
  flow from the first generic too

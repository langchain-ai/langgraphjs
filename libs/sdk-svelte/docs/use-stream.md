## `useStream` — options, return shape, reactive `threadId`

`useStream` is the root composable. It owns the thread lifecycle, the transport, and a handful of always-on reactive projections (`values`, `messages`, `toolCalls`, `interrupts`). Mount it once per thread; all scoped data flows through the [selector composables](./selector-composables.md).

Reactive properties are getters on the returned handle, so reading them in templates, `$derived`, `$effect`, or a selector-composable argument tracks them automatically.

> **Tip.** Always access fields through the live `stream` handle. Destructuring (`const { messages } = stream`) freezes the values at that moment — use `stream.messages` in templates instead.

---

## Options

The option bag is a discriminated union. Pass either the **agent-server** shape (`assistantId` + `apiUrl`/`client`) or the **custom-adapter** shape (`transport: AgentServerAdapter`) — not both.

### Common options

| Option          | Type                                       | Description                                                              |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `threadId`      | `string \| null \| (() => string \| null)` | Initial or reactive thread id. Pass a getter to drive in-place swapping. |
| `onThreadId`    | `(id: string) => void`                     | Fires when the server assigns a thread id to a new run.                  |
| `onCreated`     | `(meta: { run_id; thread_id }) => void`    | Fires as soon as a run is accepted.                                      |
| `initialValues` | `StateType`                                | Hydrate the root state before the first event arrives.                   |
| `messagesKey`   | `string`                                   | State key that holds messages. Default `"messages"`.                     |
| `tools`         | `HeadlessToolImplementation[]`             | See [Headless tools](./headless-tools.md).                               |
| `onTool`        | `OnToolCallback`                           | Observe headless tool lifecycle events.                                  |

### Agent-server branch

| Option              | Type                          | Description                                                              |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `assistantId`       | `string`                      | **Required.** Assistant / graph id.                                      |
| `apiUrl`            | `string`                      | LangGraph API base URL.                                                  |
| `apiKey`            | `string`                      | API key (alternative to a pre-built `client`).                           |
| `client`            | `Client`                      | Pre-configured `@langchain/langgraph-sdk` client.                        |
| `transport`         | `"sse" \| "websocket"`        | Wire transport. Default `"sse"`.                                         |
| `fetch`             | `typeof fetch`                | Override `fetch` (SSE only).                                             |
| `webSocketFactory`  | `(url) => WebSocket`          | Override the WS constructor.                                             |

### Custom-adapter branch

| Option         | Type                  | Description                                                                  |
| -------------- | --------------------- | ---------------------------------------------------------------------------- |
| `transport`    | `AgentServerAdapter`  | **Required.** Bring-your-own backend; see [Custom transport](./custom-transport.md). |
| `assistantId`  | `string`              | Optional. Defaults to `"_"` — ignored by adapters that don't multiplex.      |

---

## Return shape

| Field                    | Type                                  | Description                                                        |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------ |
| `values`                 | `StateType`                           | Current root state.                                                |
| `messages`               | `BaseMessage[]`                       | Messages at the root namespace.                                    |
| `toolCalls`              | `AssembledToolCall[]`                 | Tool-call rows at the root.                                        |
| `interrupts`             | `Interrupt[]`                         | All active interrupts.                                             |
| `interrupt`              | `Interrupt \| undefined`              | Convenience accessor for the first active interrupt.               |
| `isLoading`              | `boolean`                             | Whether a run is in flight.                                        |
| `isThreadLoading`        | `boolean`                             | Whether the thread is still hydrating.                             |
| `hydrationPromise`       | `Promise<void>`                       | Resolves when initial hydration completes.                         |
| `error`                  | `unknown`                             | Last error, if any.                                                |
| `threadId`               | `string \| null`                      | Active thread id.                                                  |
| `subagents`              | `ReadonlyMap<string, …>`              | Discovered subagent namespaces.                                    |
| `subgraphs`              | `ReadonlyMap<string, …>`              | Discovered subgraph namespaces.                                    |
| `subgraphsByNode`        | `ReadonlyMap<string, …>`              | Subgraph snapshots bucketed by node name.                          |
| `submit(input, options?)`| `Promise<void>`                       | Submit new input; supports `multitaskStrategy: "enqueue"`.         |
| `stop()`                 | `Promise<void>`                       | Cancel the active run.                                             |
| `respond(response, target?)` | `Promise<void>`                   | Reply to an [interrupt](./interrupts.md).                          |
| `getThread()`            | `ThreadStream \| undefined`           | v2 escape hatch.                                                   |
| `client`, `assistantId`  | —                                     | Pass-through.                                                      |

---

## Reactive `threadId`

Pass a getter to swap the bound thread without remounting:

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
  let active = $state<string | null>(null);

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    threadId: () => active,
  });

  function newThread() { active = crypto.randomUUID(); }
</script>
```

When the getter returns a different id the controller re-hydrates against the new thread; when it returns `null` the root state is cleared and the next `submit()` creates a fresh thread.

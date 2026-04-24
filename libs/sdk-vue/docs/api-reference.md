# API reference

The root composable `useStream` owns the thread lifecycle, the transport,
and a set of always-on projections. The object it returns is a plain
record of Vue refs plus imperative methods.

- Reactive fields are either `Readonly<ShallowRef<T>>` or
  `ComputedRef<T>` — read them via `.value` inside `<script setup>`,
  or directly inside `<template>` (Vue auto-unwraps refs in templates).
- The composable takes ownership of its subscriptions — when the
  enclosing Vue scope unmounts, the underlying stream controller is
  disposed automatically via `onScopeDispose`.

## `useStream` options

The option bag is a **discriminated union**:

- **LangGraph Platform** — supply `assistantId` (plus `apiUrl` or a
  pre-configured `client`). The built-in SSE transport is used by
  default; pass `transport: "websocket"` for the WebSocket variant.
- **Custom backend** — pass `transport: myAdapter` where `myAdapter`
  implements
  [`AgentServerAdapter`](https://github.com/langchain-ai/langgraphjs/blob/main/libs/sdk/src/client/stream/transport.ts)
  from `@langchain/langgraph-sdk`. `HttpAgentServerAdapter` is the
  stock HTTP/SSE implementation.

Passing both `assistantId` and an adapter is a compile-time error.

| Option | Type | Description |
|---|---|---|
| `assistantId` | `string` | **Required** for the LangGraph Platform branch. The assistant / graph ID the composable streams from. Captured at setup time — remount the composable to swap it. |
| `apiUrl` | `MaybeRefOrGetter<string>` | Base URL of the LangGraph API. LGP branch only. Reactive — updating the ref reconfigures the built-in client in place. |
| `apiKey` | `MaybeRefOrGetter<string>` | API key forwarded to the built-in `Client`. |
| `client` | `Client` | Pre-configured `@langchain/langgraph-sdk` client. |
| `callerOptions` / `defaultHeaders` | `ClientConfig` fields | Forwarded to the built-in `Client`. |
| `transport` | `"sse" \| "websocket" \| AgentServerAdapter` | Wire transport. Omit for SSE. Passing an adapter flips into the custom-backend branch. |
| `fetch` | `typeof fetch` | Optional `fetch` override for the built-in SSE transport. |
| `webSocketFactory` | `(url: string) => WebSocket` | Optional `WebSocket` factory for the built-in WS transport. |
| `threadId` | `MaybeRefOrGetter<string \| null \| undefined>` | Thread to bind to. Accepts a plain value, `null` (start a new thread on first submit), or a reactive ref / getter — updating it re-hydrates against the new thread in place. |
| `onThreadId` | `(id: string) => void` | Fires when a new thread is created server-side. |
| `onCreated` | `({ run_id, thread_id }) => void` | Fires as soon as the server acknowledges a run. |
| `initialValues` | `StateType` | Seed state used until the first payload arrives. |
| `messagesKey` | `string` | State key that carries the message array. Defaults to `"messages"`. |
| `tools` | `AnyHeadlessToolImplementation[]` | Headless tool implementations. Interrupts that target a registered tool are auto-resumed. |
| `onTool` | `OnToolCallback` | Observe lifecycle events for registered `tools`. |

Options **removed** in v1 (`onError`, `onFinish`, `onUpdateEvent`,
`onCustomEvent`, `onMetadataEvent`, `onStop`, `fetchStateHistory`,
`reconnectOnMount`, `throttle`) all have reactivity-based
replacements — see [`v1-migration.md`](./v1-migration.md) §3.

## Return shape

| Property | Type | Notes |
|---|---|---|
| `values` | `ShallowRef<StateType>` | Current graph state. Non-nullable at the root (falls back to `initialValues ?? {}`). |
| `messages` | `ShallowRef<BaseMessage[]>` | Messages assembled from the message channel. Always `BaseMessage` instances from `@langchain/core/messages`. |
| `toolCalls` | `ShallowRef<AssembledToolCall[]>` | Tool calls assembled with live status + args + results. |
| `interrupts` | `ShallowRef<Interrupt[]>` | All pending root interrupts. |
| `interrupt` | `ComputedRef<Interrupt \| undefined>` | Convenience: `interrupts.value[0]`. |
| `isLoading` | `ComputedRef<boolean>` | `true` while a run is in flight or hydration hasn't finished. |
| `isThreadLoading` | `ComputedRef<boolean>` | `true` only during initial thread hydration. |
| `error` | `ComputedRef<unknown>` | Last error surfaced by the controller. |
| `threadId` | `ComputedRef<string \| null>` | Currently-bound thread. |
| `hydrationPromise` | `ComputedRef<Promise<void>>` | Resolves once initial hydration finishes. Useful for `async setup()` / Suspense-style awaits. |
| `subagents` | `ShallowRef<ReadonlyMap<id, SubagentDiscoverySnapshot>>` | Lightweight discovery map — no messages / values. Read those via selectors. |
| `subgraphs` / `subgraphsByNode` | `ShallowRef<ReadonlyMap<…>>` | Subgraph discovery, keyed by id or by node. |
| `submit(input, options?)` | `(…) => Promise<void>` | Start / resume / fork a run. |
| `stop()` | `() => Promise<void>` | Abort the in-flight run. |
| `respond(response, target?)` | `(…) => Promise<void>` | Reply to a specific interrupt by id. |
| `client` | `Client` | Built-in `Client` when using the LGP branch. |
| `assistantId` | `string` | Resolved assistant id (defaults to `"_"` when using a custom adapter). |
| `getThread()` | `() => ThreadStream \| undefined` | Escape hatch returning the bound v2 `ThreadStream`. |

## See also

- [Selectors](./selectors.md) — scoped, ref-counted readers for
  subagent / subgraph / namespaced data.
- [Transports](./transports.md) — SSE vs WebSocket vs custom
  adapters.
- [Interrupts](./interrupts.md) — pausing a run and responding to
  interrupts (including headless tools).
- [Forking](./forking.md) — editing / branching from a message.

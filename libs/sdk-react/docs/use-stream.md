# `useStream`

The root hook of `@langchain/react` v1. Mount it once per thread. It owns the thread lifecycle, the transport, and a handful of always-on projections (`values`, `messages`, `toolCalls`, `interrupts`, `error`, `isLoading`, discovery maps).

## Table of contents

- [Options](#options)
  - [Common options](#common-options)
  - [Agent Server branch (`AgentServerOptions`)](#agent-server-branch-agentserveroptions)
  - [Custom-adapter branch (`CustomAdapterOptions`)](#custom-adapter-branch-customadapteroptions)
- [Return values](#return-values)
- [`submit()` options](#submit-options)
- [Stopping a run and responding to interrupts](#stopping-a-run-and-responding-to-interrupts)
  - [`stop()`](#stop)
  - [`respond(response, target?)`](#respondresponse-target)
  - [`hydrationPromise`](#hydrationpromise)
- [Related](#related)

## Options

The option bag is a discriminated union on `transport`:

- **Agent Server** (default) — omit `transport`, or pass `"sse"` / `"websocket"`. Requires `assistantId` + `apiUrl` (or a pre-built `client`).
- **Custom adapter** — pass an `AgentServerAdapter` instance. The hook delegates every command and subscription to the adapter. See [Transports](./transports.md).

### Common options

| Option          | Type                                    | Description                                                                                                                 |
| --------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `assistantId`   | `string`                                | Assistant/graph ID. Required on the Agent Server branch; optional (defaults to `"_"`) on the custom-adapter branch.         |
| `threadId`      | `string \| null`                        | Bind to an existing thread. Pass `null` to start a new thread on next submit; changing the value hydrates and resubscribes. |
| `initialValues` | `StateType`                             | Initial state values used until the first `values` event lands.                                                             |
| `messagesKey`   | `string`                                | State key holding the message array. Defaults to `"messages"`.                                                              |
| `onThreadId`    | `(id: string) => void`                  | Fires when the server mints a new thread id.                                                                                |
| `onCreated`     | `(meta: { run_id, thread_id }) => void` | Fires when a run is accepted by the server.                                                                                 |
| `tools`         | `HeadlessToolImplementation[]`          | Headless tools. Matching interrupts are auto-resolved with the handler's return value. See [Interrupts](./interrupts.md).   |
| `onTool`        | `OnToolCallback`                        | Observe headless-tool lifecycle events (`start` / `success` / `error`).                                                     |

### Agent Server branch (`AgentServerOptions`)

| Option                            | Type                         | Description                                        |
| --------------------------------- | ---------------------------- | -------------------------------------------------- |
| `apiUrl`                          | `string`                     | Base URL of the LangGraph-compatible agent server. |
| `client`                          | `Client`                     | Pre-built SDK client (alternative to `apiUrl`).    |
| `apiKey`                          | `string`                     | API key forwarded to the built-in client.          |
| `callerOptions`, `defaultHeaders` | `ClientConfig[...]`          | Forwarded to the built-in client.                  |
| `transport`                       | `"sse" \| "websocket"`       | Built-in wire transport. Defaults to `"sse"`.      |
| `fetch`                           | `typeof fetch`               | Optional `fetch` override for the SSE transport.   |
| `webSocketFactory`                | `(url: string) => WebSocket` | Optional WebSocket factory for the WS transport.   |

### Custom-adapter branch (`CustomAdapterOptions`)

| Option      | Type                 | Description                                                       |
| ----------- | -------------------- | ----------------------------------------------------------------- |
| `transport` | `AgentServerAdapter` | Adapter instance. Replaces the built-in transport stack entirely. |

Passing `apiUrl` / `apiKey` / `fetch` / `webSocketFactory` on the custom-adapter branch is a compile-time error.

## Return values

| Property                     | Type                                                        | Description                                                                                     |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `values`                     | `StateType`                                                 | Latest root `values`-channel snapshot (falls back to `initialValues ?? {}`).                    |
| `messages`                   | `BaseMessage[]`                                             | Root message projection; merges `messages`-channel deltas and `values.messages` snapshots.      |
| `toolCalls`                  | `AssembledToolCall[]`                                       | Tool calls assembled from the root run; each carries `status`, `args`, `result`, `aiMessageId`. |
| `interrupt` / `interrupts`   | `Interrupt \| Interrupt[]`                                  | Most-recent root interrupt and the full interrupt list.                                         |
| `isLoading`                  | `boolean`                                                   | True while a run is in flight or initial hydration hasn't completed.                            |
| `isThreadLoading`            | `boolean`                                                   | True during the initial thread-hydration lifecycle.                                             |
| `hydrationPromise`           | `Promise<void>`                                             | Settles when the active thread's initial hydrate resolves. Used by `useSuspenseStream`.         |
| `error`                      | `unknown`                                                   | Latest transport or hydrate error.                                                              |
| `threadId`                   | `string \| null`                                            | Currently bound thread id.                                                                      |
| `subagents`                  | `ReadonlyMap<string, SubagentDiscoverySnapshot>`            | Discovery snapshots for subagents on the thread (identity only — no messages / tool calls).     |
| `subgraphs`                  | `ReadonlyMap<string, SubgraphDiscoverySnapshot>`            | Subgraphs discovered on the run.                                                                |
| `subgraphsByNode`            | `ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>` | Same snapshots keyed by the graph node that produced them.                                      |
| `submit(input, options?)`    | function                                                    | Dispatch a new run on the bound thread.                                                         |
| `stop()`                     | `() => Promise<void>`                                       | Abort the in-flight run.                                                                        |
| `respond(response, target?)` | function                                                    | Resume an interrupt with a response payload.                                                    |
| `getThread()`                | `() => ThreadStream \| undefined`                           | Escape hatch to the underlying v2 `ThreadStream`.                                               |
| `client`                     | `Client`                                                    | The bound client (`HttpAgentServerAdapter`'s client on the custom branch).                      |
| `assistantId`                | `string`                                                    | Resolved assistant id (including the `"_"` fallback on custom adapters).                        |

## `submit()` options

`submit()` accepts `Partial<StateType>` as input (`messages` is widened to also accept `BaseMessage` class instances, or a single message). Pass `null` / `undefined` when resuming an interrupt via `options.command.resume`.

| Option                              | Type                                                 | Description                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`                            | `{ configurable?, tags?, recursion_limit?, ... }`    | Run config forwarded to the server.                                                                                                                                       |
| `metadata`                          | `Record<string, unknown>`                            | Run metadata.                                                                                                                                                             |
| `command`                           | `{ resume?, goto?, update? }`                        | Resume / steer an interrupted run.                                                                                                                                        |
| `multitaskStrategy`                 | `"rollback" \| "interrupt" \| "reject" \| "enqueue"` | How to handle a submit while a run is active. See [Submission queue](./submission-queue.md).                                                                              |
| `forkFrom`                          | `{ checkpointId: string }`                           | Fork the new run from a specific checkpoint (edit / retry flows). See [Fork / edit from a checkpoint](./fork-from-checkpoint.md).                                         |
| `interruptBefore`, `interruptAfter` | `string[]`                                           | Breakpoint debugging.                                                                                                                                                     |
| `runId`                             | `string`                                             | Pre-generate a run id (for optimistic UI / telemetry).                                                                                                                    |
| `durability`                        | `"async" \| "sync" \| "exit"`                        | Checkpoint policy.                                                                                                                                                        |
| `context`                           | `unknown`                                            | Runtime context (distinct from `config.configurable`).                                                                                                                    |
| `feedbackKeys`                      | `string[]`                                           | LangSmith integration.                                                                                                                                                    |
| `threadId`                          | `string`                                             | Per-submit thread override — rebinds the hook to `threadId` before dispatching. Subsequent submits stay on the new thread until the hook's `threadId` prop changes again. |
| `onError`                           | `(error: unknown) => void`                           | Per-submit error callback. Fires for the specific `submit()` it was passed; the transport-level `stream.error` store update still happens.                                |

## Stopping a run and responding to interrupts

### `stop()`

`stream.stop()` aborts the in-flight run. The transport `AbortController` fires, the `messages` / `toolCalls` projections stop receiving deltas, and `values` reverts to the server's authoritative snapshot after reconciliation. Safe to call unconditionally — when no run is active it is a no-op.

```tsx
<button onClick={() => void stream.stop()} disabled={!stream.isLoading}>
  Stop
</button>
```

### `respond(response, target?)`

Resume a specific interrupt from anywhere in the tree. The target selects which pending interrupt to resolve — useful when multiple concurrent interrupts are in flight (subagents, fan-out, nested graphs). When `target` is omitted, the most recent root interrupt is resumed.

```tsx
// Resolve the latest root interrupt:
await stream.respond({ approved: true });

// Resolve a specific interrupt by id:
await stream.respond(
  { approved: true },
  { interruptId: myInterrupt.id, namespace: ["subagent"] },
);
```

For the common "user approves / rejects a pending interrupt" flow at the root, `submit(null, { command: { resume: value } })` is equivalent and slightly more ergonomic. See [Interrupts](./interrupts.md).

### `hydrationPromise`

`stream.hydrationPromise` settles when the thread's initial hydration resolves (or rejects). The same promise is exposed on every render — a fresh one is installed every time the hook binds to a new `threadId`. [`useSuspenseStream`](./suspense.md) leans on this directly. In plain `useStream` apps you rarely need it, but it's useful for server-rendered-then-hydrated views that want to show a skeleton until the first snapshot lands:

```tsx
useEffect(() => {
  let cancelled = false;
  stream.hydrationPromise.then(() => {
    if (!cancelled) setHydrated(true);
  });
  return () => {
    cancelled = true;
  };
}, [stream.hydrationPromise]);
```

## Related

- [Companion selector hooks](./selectors.md)
- [Transports](./transports.md)
- [Interrupts & headless tools](./interrupts.md)
- [Type safety](./type-safety.md)

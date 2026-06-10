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
  - [`respond(response, options?)`](#respondresponse-options)
  - [`respondAll(responsesById, options?)`](#respondallresponsesbyid-options)
  - [`hydrationPromise`](#hydrationpromise)
- [Related](#related)

## Options

The option bag is a discriminated union on `transport`:

- **Agent Server** (default) — omit `transport`, or pass `"sse"` / `"websocket"`. Requires `assistantId` + `apiUrl` (or a pre-built `client`).
- **Custom adapter** — pass an `AgentServerAdapter` instance. The hook delegates every command and subscription to the adapter. See [Transports](./transports.md).

### Common options

| Option          | Type                                                                                      | Description                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `assistantId`   | `string`                                                                                  | Assistant/graph ID. Required on the Agent Server branch; optional (defaults to `"_"`) on the custom-adapter branch.         |
| `threadId`      | `string \| null`                                                                          | Bind to an existing thread. Pass `null` to start a new thread on next submit; changing the value hydrates and resubscribes. |
| `initialValues` | `StateType`                                                                               | Initial state values used until the first `values` event lands.                                                             |
| `messagesKey`   | `string`                                                                                  | State key holding the message array. Defaults to `"messages"`.                                                              |
| `onThreadId`    | `(id: string) => void`                                                                    | Fires when the server mints a new thread id.                                                                                |
| `onCreated`     | `(info: { runId: string }) => void`                                                       | Convenience callback fired when this hook's run is accepted by the server.                                                  |
| `onCompleted`   | `(info: { runId?: string; reason: "success" \| "error" \| "interrupt" \| "stopped" }) => void` | Convenience callback fired when a run's active streaming phase ends. `runId` may be omitted for re-attached in-flight runs. |
| `tools`         | `HeadlessToolImplementation[]`                                                            | Headless tools. Matching interrupts are auto-resolved with the handler's return value. See [Interrupts](./interrupts.md).   |
| `onTool`        | `OnToolCallback`                                                                          | Observe headless-tool lifecycle events (`start` / `success` / `error`).                                                     |
| `optimistic`    | `boolean`                                                                                 | Echo `submit()` input into `values` / `messages` immediately and reconcile by id as the server streams back. Defaults to `true`. Set `false` for server-authoritative-only. See [v1 migration §5.4](./v1-migration.md). |

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
| `stop(options?)`             | `(options?: { cancel?: boolean }) => Promise<void>`       | Cancel the active run (default) and disconnect the client. Pass `{ cancel: false }` to disconnect only. |
| `disconnect()`               | `() => Promise<void>`                                     | Disconnect the client without cancelling the run (`stop({ cancel: false })`).                          |
| `respond(response, options?)` | function                                                    | Resume a single interrupt with a response payload (target via `options.interruptId` / `namespace`). |
| `respondAll(responsesById, options?)` | function                                            | Resume several interrupts pending at the same checkpoint in one command (`interruptId` → response map). |
| `getThread()`                | `() => ThreadStream \| undefined`                           | Returns the bound `ThreadStream` for low-level protocol access; `undefined` until a thread is bound. |
| `client`                     | `Client`                                                    | The bound client (`HttpAgentServerAdapter`'s client on the custom branch).                      |
| `assistantId`                | `string`                                                    | Resolved assistant id (including the `"_"` fallback on custom adapters).                        |

## `submit()` options

`submit()` accepts `Partial<StateType>` as input (`messages` is widened to also accept `BaseMessage` class instances, or a single message). To resume a pending interrupt, use `stream.respond()` instead.

| Option                              | Type                                                 | Description                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`                            | `{ configurable?, tags?, recursion_limit?, ... }`    | Run config forwarded to the server.                                                                                                                                       |
| `metadata`                          | `Record<string, unknown>`                            | Run metadata.                                                                                                                                                             |
| `multitaskStrategy`                 | `"rollback" \| "interrupt" \| "reject" \| "enqueue"` | How to handle a submit while a run is active. See [Submission queue](./submission-queue.md).                                                                              |
| `forkFrom`                          | `string`                                             | Fork the new run from a specific checkpoint id (edit / retry flows). See [Fork / edit from a checkpoint](./fork-from-checkpoint.md).                                      |
| `interruptBefore`, `interruptAfter` | `string[]`                                           | Breakpoint debugging.                                                                                                                                                     |
| `runId`                             | `string`                                             | Pre-generate a run id (for optimistic UI / telemetry).                                                                                                                    |
| `durability`                        | `"async" \| "sync" \| "exit"`                        | Checkpoint policy.                                                                                                                                                        |
| `context`                           | `unknown`                                            | Runtime context (distinct from `config.configurable`).                                                                                                                    |
| `feedbackKeys`                      | `string[]`                                           | LangSmith integration.                                                                                                                                                    |
| `threadId`                          | `string`                                             | Per-submit thread override — rebinds the hook to `threadId` before dispatching. Subsequent submits stay on the new thread until the hook's `threadId` prop changes again. |
| `onError`                           | `(error: unknown) => void`                           | Per-submit error callback. Fires for the specific `submit()` it was passed; the transport-level `stream.error` store update still happens.                                |

## Stopping a run and responding to interrupts

### `stop()`

`stream.stop()` cancels the active run by default: it disconnects the client transport, calls `client.runs.cancel` on the server, and sets `isLoading` to `false`. Messages and values received so far are preserved. Safe to call unconditionally — when no run is active it is a no-op.

```tsx
<button onClick={() => void stream.stop()} disabled={!stream.isLoading}>
  Stop
</button>
```

Pass `{ cancel: false }` to disconnect without cancelling server-side execution, or use `stream.disconnect()` (see below).

### `disconnect()`

`stream.disconnect()` is an alias for `stop({ cancel: false })`. Use it in join/rejoin UIs where the agent should keep running after the client leaves the stream.

```tsx
<button onClick={() => void stream.disconnect()} disabled={!stream.isLoading}>
  Disconnect
</button>
```

### `respond(response, options?)`

Resume a single pending interrupt. When `options.interruptId` is omitted, `respond()` walks `stream.getThread()?.interrupts` from newest to oldest and resumes the first entry not yet resolved by a prior `respond()` call. That may be a root or subgraph interrupt — it is **not** necessarily `stream.interrupt` (`stream.interrupts[0]`, root-only). Safe when exactly one interrupt is pending; otherwise pass `options.interruptId` (and `options.namespace` for subgraph interrupts).

The server validates `namespace` against the pending interrupt. Root interrupts use `namespace: []` (default when omitted). For subgraph interrupts, copy `namespace` from `getThread()?.interrupts` — see [Interrupts](./interrupts.md#subgraph-interrupts-and-namespace).

Pass `options.config` / `options.metadata` to fold run-level config (model, user context, …) and metadata (trigger source, test flags, …) into the resumed run, mirroring `submit()`.

```tsx
// Single pending interrupt — omit target:
await stream.respond({ approved: true });

// Multiple root interrupts — target by id:
await stream.respond({ approved: true }, { interruptId: myInterrupt.id! });

// Subgraph interrupt — namespace from getThread():
const entry = stream.getThread()?.interrupts.find(
  (e) => e.interruptId === myInterruptId,
);
await stream.respond(
  { approved: true },
  { interruptId: entry!.interruptId, namespace: entry!.namespace },
);

// Carry run config + metadata onto the resume:
await stream.respond({ approved: true }, {
  config: { configurable: { model: "gpt-4o" } },
  metadata: { source: "ui" },
});
```

See [Interrupts](./interrupts.md) for HITL resume patterns.

### `respondAll(responsesById, options?)`

Resume several interrupts pending at the same checkpoint (e.g. parallel tool-authorization prompts) in a single command. Sequential `respond()` calls would fail because the first resume starts a run, leaving the rest with no interrupted run to respond to. `responsesById` maps each pending `interruptId` to its response, so different interrupts can receive different payloads; namespaces are resolved internally from `getThread()?.interrupts`. `options.config` / `options.metadata` fold run-level config and metadata into the single run that services the resume.

```tsx
// Distinct payloads per interrupt:
await stream.respondAll({
  [interruptA.id]: { approved: true },
  [interruptB.id]: { approved: false },
});

// Same payload to every pending interrupt:
await stream.respondAll(
  Object.fromEntries(stream.interrupts.map((i) => [i.id!, { approved: true }])),
);
```

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

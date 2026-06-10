# Migrating from `@langchain/svelte` v0 to v1

`@langchain/svelte` **v1** targets **new event-based streaming**. The `useStream` import stays the same, but the option bag, return shape, and how you subscribe to scoped data all change. Most chat apps migrate in well under an hour.

## Why the breaking change

The v0 binding was built on the legacy streaming protocol and accreted a large surface of opt-in callbacks (`onUpdateEvent`, `onCustomEvent`, `onDebugEvent`, `onCheckpointEvent`, …) and derived state (`history`, `branch`, `experimental_branchTree`, `activeSubagents`, `subagents`) that had to be recomputed on every update — whether or not any component was rendering it.

v1 flips that around:

- **Always-on root projections.** `values` / `messages` / `toolCalls` / `interrupts` are always reactive at the root with no extra subscription cost beyond the wire.
- **Selector composables for scoped data.** Per-subagent / per-subgraph messages, tool calls, and media are only opened when a component actually mounts a selector (`useMessages(stream, subagent)`), and released on unmount.
- **Discriminated option bag.** The LGP branch and the custom-adapter branch are two arms of a discriminated union. Passing LGP-only options like `apiUrl`, `client`, or `fetch` alongside a custom `transport: AgentServerAdapter` is a compile-time error.
- **Reactive `threadId`.** Pass `threadId: () => active` to drive in-place thread swaps; everything else is captured at mount.
- **First-class re-attach.** Remounting a component on an in-flight thread attaches to the live subscription instead of replaying from scratch.

## TL;DR checklist

- [ ] Upgrade `@langchain/svelte` to `^1.0.0` and
      `@langchain/langgraph-sdk` to the matching new event-based streaming
      runtime.
- [ ] Import `useStream` only — `useStreamExperimental` is not exported from this package.
- [ ] Remove the following options — they are gone: `onFinish`, `onUpdateEvent`, `onCustomEvent`, `onMetadataEvent`, `onLangChainEvent`, `onDebugEvent`, `onCheckpointEvent`, `onTaskEvent`, `onStop`, `onError`, `fetchStateHistory`, `throttle`, `filterSubagentMessages`, `subagentToolNames`.
- [ ] Replace `transport: new FetchStreamTransport(…)` with `transport: new HttpAgentServerAdapter(…)` from `@langchain/svelte` (or `@langchain/langgraph-sdk`). The adapter is bound to a concrete `threadId`.
- [ ] Stop destructuring and reading the following from the return — they moved or were dropped: `branch`, `setBranch`, `history`, `experimental_branchTree`, `getMessagesMetadata`, `joinStream`, `switchThread`, `queue`, `activeSubagents`, `getSubagent`, `getSubagentsByType`, `getSubagentsByMessage`.
- [ ] Read message metadata via `useMessageMetadata(stream, () => msg.id)` instead of `stream.getMessagesMetadata(msg)`.
- [ ] Read the submission queue via `useSubmissionQueue(stream)` instead of `stream.queue`.
- [ ] Drive thread swaps by passing `threadId: () => active` instead of calling `stream.switchThread(id)`.
- [ ] Read per-subagent data with `useMessages(stream, subagent)` / `useToolCalls(stream, subagent)` / `useValues(stream, subagent)` instead of `subagent.messages` / `subagent.toolCalls`.
- [ ] Remove per-submit disconnect options — `onDisconnect` and `streamResumable` are gone from `submit()`. Use `stream.stop()` (cancel, default) or `stream.disconnect()` (join/rejoin) instead (see recipe below).
- [ ] Re-run `svelte-check` / `tsc`. The option bag and return shape are now strongly discriminated, so most remaining issues surface as type errors mapped to the tables below.

## Option bag

| v0 option                                                                                                                   | v1 equivalent                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `assistantId`                                                                                                               | **same** — required on the LGP branch, defaults to `"_"` for custom adapters                                                      |
| `apiUrl` / `apiKey`                                                                                                         | **same**                                                                                                                          |
| `client`                                                                                                                    | **same**                                                                                                                          |
| `threadId` (static)                                                                                                         | **same**; also accepts a getter `() => string \| null` for reactive swapping                                                      |
| `initialValues`                                                                                                             | **same**                                                                                                                          |
| `messagesKey`                                                                                                               | **same** (default `"messages"`)                                                                                                   |
| `onThreadId`                                                                                                                | **same**                                                                                                                          |
| `onCreated`                                                                                                                 | fires with `{ runId }`; read the current thread from `stream.threadId` when needed                                                |
| `onCompleted`                                                                                                               | convenience callback with `{ runId?, reason }` when active streaming ends                                                         |
| `transport`                                                                                                                 | now `"sse"` \| `"websocket"` \| an `AgentServerAdapter` instance. `HttpAgentServerAdapter` requires `apiUrl` and `threadId`.      |
| `fetch` / `webSocketFactory`                                                                                                | **same** on the LGP branch only                                                                                                   |
| `tools` + `onTool`                                                                                                          | **new** headless-tool channel (see [Headless tools](./headless-tools.md))                                                         |
| `onFinish`, `onError`, `onStop`                                                                                             | hook-level callbacks removed — observe `stream.isLoading` / `stream.error` reactively, or pass per-submit `onError` to `submit()`. Use `stream.stop()` / `stream.disconnect()` instead of `onStop` (see recipe below). |
| `onDisconnect`, `streamResumable` (on `submit`)                                                                             | removed from submit — use `stream.stop()` (cancel, default) or `stream.disconnect()` (join/rejoin) on the stream handle                                                                                               |
| `onUpdateEvent`, `onCustomEvent`, `onDebugEvent`, `onCheckpointEvent`, `onTaskEvent`, `onMetadataEvent`, `onLangChainEvent` | removed — use `useChannelEffect` for per-event side effects (analytics), `useChannel` for a rendered event buffer, or the dedicated [selector composables](./selector-composables.md) |
| `fetchStateHistory`                                                                                                         | removed — fork / branch flows are driven by `useMessageMetadata`                                                                  |
| `throttle`                                                                                                                  | removed — the controller batches its own notifications                                                                            |
| `filterSubagentMessages`, `subagentToolNames`                                                                               | removed — subagent views are per-namespace via `useMessages(stream, sub)`                                                         |

## Return-shape changes

| v0 field / method                                                               | v1 equivalent                                                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `values`, `messages`, `isLoading`, `error`, `interrupt`, `interrupts`           | **same**                                                                                                                                                              |
| `threadId`                                                                      | **same**                                                                                                                                                              |
| `isThreadLoading`                                                               | **same** — plus `hydrationPromise` for SvelteKit `load()` handlers                                                                                                    |
| `submit(values, options?)`                                                      | **same** — returns `Promise<void>`; options now include `forkFrom`, per-submit `threadId`, per-submit `onError`, and `multitaskStrategy`                              |
| `stop(options?)`                                                                | cancels the active run server-side by default (`{ cancel: true }`); pass `{ cancel: false }` or call `disconnect()` for join/rejoin                                                  |
| `disconnect()`                                                                  | **new** — alias for `stop({ cancel: false })`; agent keeps running server-side                                                                                                      |
| `client`, `assistantId`                                                         | **same**                                                                                                                                                              |
| `toolCalls`                                                                     | **same** — assembled tool-call rows at the root                                                                                                                       |
| `subagents`, `subgraphs`, `subgraphsByNode`                                     | **new** — discovery snapshots (namespaces). Use them as the `target` argument to selector composables                                                                 |
| `respond(response, options?)` / `respondAll(responsesById, options?)`           | **new** — resume the agent after an interrupt (`respondAll` resumes several at the same checkpoint)                                                                    |
| `getThread()`                                                                   | **new** — returns the bound `ThreadStream` for low-level protocol access                                                                                              |
| `branch`, `setBranch`                                                           | removed — there is no global branch pointer with new event-based streaming. Fork flows use `submit(input, { forkFrom })` and `parentCheckpointId` from `useMessageMetadata`. |
| `history`, `experimental_branchTree`                                            | removed — pull history via the `Client` directly when needed                                                                                                          |
| `getMessagesMetadata(msg)`                                                      | `useMessageMetadata(stream, () => msg.id)` → `{ parentCheckpointId }`                                                                                                 |
| `joinStream(...)`                                                               | removed — `useStream` attaches automatically on mount                                                                                                                 |
| `switchThread(id)`                                                              | pass `threadId: () => active` as a getter; update the underlying state                                                                                                |
| `queue.*`                                                                       | `useSubmissionQueue(stream)` → `{ entries, size, cancel, clear }`                                                                                                     |
| `activeSubagents`, `getSubagent`, `getSubagentsByType`, `getSubagentsByMessage` | drop — read through `stream.subagents` (`ReadonlyMap`) plus selector composables                                                                                      |

## Recipes

### Replace `getMessagesMetadata`

```svelte
<!-- v0 -->
<script lang="ts">
  const meta = stream.getMessagesMetadata(msg, i);
  const parent = meta?.firstSeenState?.parent_checkpoint;
</script>

<!-- v1 -->
<script lang="ts">
  import { useMessageMetadata } from "@langchain/svelte";
  const meta = useMessageMetadata(stream, () => msg.id);
</script>
Parent: {meta.current?.parentCheckpointId ?? "root"}
```

### Replace `stream.queue`

```svelte
<script lang="ts">
  import { useSubmissionQueue } from "@langchain/svelte";
  const queue = useSubmissionQueue(stream);
</script>

{#if queue.size > 0}
  <p>{queue.size} run(s) pending</p>
  <button onclick={() => queue.clear()}>Clear</button>
{/if}
```

### Replace `stream.switchThread(id)`

```svelte
<script lang="ts">
  let active = $state<string | null>(null);
  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    threadId: () => active,
  });
</script>

<button onclick={() => (active = crypto.randomUUID())}>New thread</button>
```

Passing `null` clears the thread; the next `submit()` creates a fresh one.

### Replace `onDisconnect` / join-rejoin stop

```svelte
<!-- v0 — disconnect policy on submit -->
<script lang="ts">
  await stream.submit(input, { onDisconnect: "continue", streamResumable: true });
  // stream.stop() only aborted the client
</script>

<!-- v1 — explicit stop vs disconnect -->
<script lang="ts">
  await stream.submit(input);
  await stream.stop();        // chat cancel (server + client)
  await stream.disconnect();  // join/rejoin (client only)
</script>
```

`runs.cancel` is issued only once `onCreated` has provided a `runId`.

### Replace custom transports

```svelte
<script lang="ts">
  import { HttpAgentServerAdapter, useStream } from "@langchain/svelte";

  const stream = useStream({
    transport: new HttpAgentServerAdapter({
      apiUrl: "/api/agent",
      threadId: "thread-123",
      defaultHeaders: { Authorization: `Bearer ${token}` },
    }),
  });
</script>
```

When `transport` is an `AgentServerAdapter`, LGP-specific options like
`client`, `apiUrl`, `apiKey`, `fetch`, and `webSocketFactory` are not
accepted on the `useStream` option bag; the adapter owns those details.
`assistantId` remains optional for adapters that multiplex internally.

### Multitask strategies

`"rollback"` remains the default. `"reject"` errors client-side when a
run is already in flight, and `"enqueue"` records the submission in the
client queue exposed by `useSubmissionQueue(stream)`. `"interrupt"` is
accepted by the type surface and currently falls back to `"rollback"`
until server-side interrupt semantics land.

### Replace subagent fan-out

```svelte
<!-- v0 -->
{#each stream.activeSubagents as sub (sub.id)}
  {#each sub.messages as msg (msg.id)}
    <div>{msg.content}</div>
  {/each}
{/each}

<!-- v1 -->
<script lang="ts">
  import { useMessages } from "@langchain/svelte";
</script>
{#each [...stream.subagents.values()] as sub (sub.namespace.join("/"))}
  {@const subMessages = useMessages(stream, sub)}
  {#each subMessages.current as msg (msg.id)}
    <div>{msg.content}</div>
  {/each}
{/each}
```

Each mounted `useMessages(stream, sub)` opens a ref-counted namespace subscription on demand and releases it on unmount.

## Type helpers

| Helper              | Use                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `UseStreamReturn<T>` | Fully-resolved return type of `useStream<T>`.                                                                                    |
| `AnyStream`         | Type-erased handle (`UseStreamReturn<any, any, any>`) for components that only forward the stream to selector hooks.             |
| `UseStreamOptions`  | Discriminated options union (LGP branch vs custom `AgentServerAdapter`); rarely needed at call sites.                            |
| `InferStateType<T>` | Unwraps a compiled graph / agent brand into its state shape.                                                                     |
| `UseSubmissionQueueReturn` | Return shape of `useSubmissionQueue(stream)` (`entries`, `size`, `cancel`, `clear`).                                      |

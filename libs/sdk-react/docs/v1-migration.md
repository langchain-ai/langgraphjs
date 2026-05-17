# Migrating to `@langchain/react` v1

This guide walks application authors through the jump from the pre-v1
`useStream` hook (previously shipped as `@langchain/langgraph-sdk/react`
and later re-exported as `@langchain/react`) to the v2-native `useStream`
that ships with `@langchain/react` **v1**.

Short version: **the `useStream` import name does not change, but the
return shape, option bag, and protocol semantics do.** Most chat apps
migrate in well under an hour by following the checklists below. Apps
that lean heavily on `history` / `branch` / `fetchStateHistory` or on a
custom `UseStreamTransport` have more work to do and are covered in
dedicated sections.

---

## Table of contents

1. [Why the breaking change?](#1-why-the-breaking-change)
2. [TL;DR migration checklist](#2-tldr-migration-checklist)
3. [Option-bag migration](#3-option-bag-migration)
4. [Return-shape migration](#4-return-shape-migration)
5. [`submit()` signature changes](#5-submit-signature-changes)
6. [Companion selector hooks — the new mental model](#6-companion-selector-hooks--the-new-mental-model)
7. [Subagents & subgraphs](#7-subagents--subgraphs)
8. [Headless tools (`tools` + `onTool`)](#8-headless-tools-tools--ontool)
9. [Custom transports: `UseStreamTransport` → `AgentServerAdapter`](#9-custom-transports-usestreamtransport--agentserveradapter)
10. [`StreamProvider` / `useStreamContext`](#10-streamprovider--usestreamcontext)
11. [`useSuspenseStream`](#11-usesuspensestream)
12. [Type helpers: `UseStream<T>` → `UseStreamReturn<T>` & friends](#12-type-helpers)
13. [Known gaps & server-side prerequisites](#13-known-gaps--server-side-prerequisites)
14. [FAQ](#14-faq)

---

## 1. Why the breaking change?

The legacy `useStream` was built against the v1 streaming protocol and
accreted a large surface of opt-in callbacks (`onUpdateEvent`,
`onCustomEvent`, `onMetadataEvent`, `onLangChainEvent`, `onDebugEvent`,
`onCheckpointEvent`, `onTaskEvent`, `onToolEvent`, `onStop`, …) plus
derived state (`history`, `branch`, `experimental_branchTree`,
`getMessagesMetadata`, `joinStream`) that had to be recomputed on every
render.

The v1 hook targets protocol v2. In practice that means:

- **Selector-based subscriptions.** Namespaced data (subagent messages,
  subgraph tool calls, media) is opened _only_ when a component actually
  mounts a selector hook, and released on unmount. No more fan-out cost
  for views that aren't on screen.
- **Always-on root projections.** `values` / `messages` / `toolCalls` /
  `interrupts` are always available at the root with zero wire cost
  beyond the protocol stream itself.
- **First-class re-attach.** Remounting a hook on an in-flight thread
  attaches to the live subscription instead of replaying from scratch;
  `isLoading` behaves consistently across page navigations and
  `<StrictMode>`.
- **Discriminated option bag.** The LGP path and the custom-adapter path
  are now two arms of a discriminated union, so passing both
  `assistantId` and `agentServerAdapter` is a compile-time error.
- **Type inference from agent brands.** `typeof agent` flows through to
  `values`, `toolCalls[].args`, and subagent-state maps without any
  `<MyState, MyBag>` boilerplate.

The net effect is a smaller, faster, more predictable API that still
covers every scenario the legacy hook supported.

---

## 2. TL;DR migration checklist

For the typical app this is the whole migration. Deeper changes are
flagged in the later sections.

- [ ] **Upgrade** `@langchain/react` to `^1.0.0` and
      `@langchain/langgraph-sdk` to the matching v2 runtime.
- [ ] **Imports stay the same** — `import { useStream } from "@langchain/react"`
      now resolves to the v2-native hook. `useStreamExperimental` is
      kept as an alias for one minor for call sites that were on the
      preview; new code should import `useStream`.
- [ ] **Remove these option-bag fields** (they are gone; see §3):
      `onError`, `onFinish`, `onUpdateEvent`, `onCustomEvent`,
      `onMetadataEvent`, `onLangChainEvent`, `onDebugEvent`,
      `onCheckpointEvent`, `onTaskEvent`, `onToolEvent`, `onStop`,
      `fetchStateHistory`, `reconnectOnMount`, `throttle`, `thread`,
      `filterSubagentMessages`, `subagentToolNames`.
- [ ] **Replace `transport: new FetchStreamTransport(...)`** with
      `transport: new HttpAgentServerAdapter(...)` — the legacy
      `FetchStreamTransport` class is no longer exported (see §9).
- [ ] **Remove these return-shape fields** (they moved or were dropped;
      see §4): `branch`, `setBranch`, `history`, `experimental_branchTree`,
      `getMessagesMetadata`, `toolProgress`, `joinStream`,
      `switchThread`, `queue`, `activeSubagents`, `getSubagent`,
      `getSubagentsByType`, `getSubagentsByMessage`.
- [ ] **Replace `getMessagesMetadata(msg)?.firstSeenState?.parent_checkpoint`**
      with `useMessageMetadata(stream, msg.id)?.parentCheckpointId` (see
      §6).
- [ ] **Replace `stream.queue`** with `useSubmissionQueue(stream)` (see
      §6).
- [ ] **Replace `stream.switchThread(id)`** with passing a new `threadId`
      prop and letting the hook reload on change (see §4).
- [ ] **Inside subagent-aware UIs**, read per-subagent data with the new
      selector hooks (`useMessages(stream, subagent)` etc.) rather than
      reading `subagent.messages` / `subagent.toolCalls` off the
      discovery snapshot (see §7).
- [ ] **Suspense apps:** `useSuspenseStream` now returns the v1 shape
      (matching `useStream` minus `isLoading` / `isThreadLoading` /
      `hydrationPromise`, plus `isStreaming`). Remove any
      `suspenseCache`, `createSuspenseCache`, or `fetchStateHistory`
      props (see §11).
- [ ] **Re-run `tsc`**. The option bag and return type are now
      discriminated and strongly typed; most remaining issues will
      surface as type errors that map to one of the sections below.

---

## 3. Option-bag migration

### 3.1 Still supported — same meaning

These keep working without changes:

| Option                                                | Notes                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `assistantId`                                         | Required for the LGP path; optional (defaults to `"_"`) for custom adapters.                |
| `client`                                              | LGP branch only.                                                                            |
| `apiUrl`, `apiKey`, `callerOptions`, `defaultHeaders` | LGP branch only. Passed to the auto-constructed `Client`.                                   |
| `threadId`, `onThreadId`                              | Unchanged. Pass `null` to detach; passing a new string reloads the thread and resubscribes. |
| `initialValues`                                       | Unchanged.                                                                                  |
| `messagesKey`                                         | Unchanged — defaults to `"messages"`.                                                       |
| `onCreated`                                           | Still fires with `{ run_id, thread_id }`.                                                   |
| `tools`, `onTool`                                     | Unchanged semantics; see §8.                                                                |

### 3.2 New option

| Option             | Notes                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`        | Two meanings: `"sse"` / `"websocket"` selects the built-in wire transport (LGP branch, default `"sse"`); an `AgentServerAdapter` instance flips the hook into the custom-adapter branch. |
| `fetch`            | LGP branch only. Forwarded to the built-in SSE transport.                                                                                                                                |
| `webSocketFactory` | LGP branch only. Forwarded to the built-in WebSocket transport.                                                                                                                          |

### 3.3 Removed — with replacements

| Legacy option                                                                                                                              | v1 replacement                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onError` (hook-level)                                                                                                                     | Read `stream.error` directly, or pass a per-submit `onError` via `submit(input, { onError })` — the v1 per-submit callback is fire-and-forget and scoped to the one submission it was passed to.                                                    |
| `onFinish`                                                                                                                                 | Derive from `isLoading` transitioning `true → false`, or observe the thread via `useValues(stream)`.                                                                                                                                                |
| `onUpdateEvent`, `onCustomEvent`, `onMetadataEvent`, `onLangChainEvent`, `onDebugEvent`, `onCheckpointEvent`, `onTaskEvent`, `onToolEvent` | Drop. The v2 protocol delivers these as structured store updates; read them via selector hooks (`useChannel`, `useExtension`) when you genuinely need raw events.                                                                                   |
| `onStop`                                                                                                                                   | Drop. `stop()` now abort-signals the in-flight run and `values` reverts to the server's authoritative state. If you previously used `mutate` to optimistically tag UI, call `stream.submit(null, { command: { update: ... } })` after stop instead. |
| `fetchStateHistory`                                                                                                                        | Drop. Fork/edit flows use `useMessageMetadata` + `submit({}, { forkFrom })` instead (§5).                                                                                                                                                           |
| `reconnectOnMount`                                                                                                                         | Drop. Re-attach is automatic: remounting the hook with the same `threadId` attaches to the in-flight run.                                                                                                                                           |
| `throttle`                                                                                                                                 | Drop. The hook batches state updates natively; call sites that need render throttling can memoize at the selector site.                                                                                                                             |
| `thread`                                                                                                                                   | Drop. External thread managers should drive the hook by controlling `threadId` and `initialValues`.                                                                                                                                                 |
| `filterSubagentMessages`                                                                                                                   | Drop. Subagent messages are already absent from `stream.messages`; they live on per-subagent selector hooks (§7).                                                                                                                                   |
| `subagentToolNames`                                                                                                                        | Drop. Subagent classification is driven by protocol-v2 lifecycle events, not by a client-side tool-name list.                                                                                                                                       |

Any previously silent callback-based side effects should migrate into
effects that watch the relevant projection:

```tsx
// Before
useStream({ onFinish: (state) => analytics.track("turn_finished", state) });

// After
const stream = useStream({ assistantId });
useEffect(() => {
  if (!stream.isLoading) analytics.track("turn_finished", stream.values);
}, [stream.isLoading, stream.values]);
```

---

## 4. Return-shape migration

### 4.1 Still there — same meaning

| Field                       | Notes                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `values`                    | Now typed as the resolved `StateType`, non-nullable at the root (falls back to `initialValues ?? {}`). |
| `messages`                  | `BaseMessage[]` class instances from `langchain`.                                                      |
| `toolCalls`                 | `AssembledToolCall[]` — renamed shape, see §4.3.                                                       |
| `interrupts`, `interrupt`   | Unchanged. `interrupt` is the most recent root interrupt.                                              |
| `isLoading`                 | True while a run is in flight _or_ initial hydration hasn't completed.                                 |
| `error`                     | Unchanged.                                                                                             |
| `threadId`                  | Unchanged.                                                                                             |
| `client`                    | LGP `Client` when the built-in transport is in use.                                                    |
| `assistantId`               | Resolved value including the `"_"` fallback used by custom adapters.                                   |
| `submit`, `stop`, `respond` | Same high-level semantics; `submit`'s argument types are wider, see §5.                                |

### 4.2 Still there — different meaning

| Field             | What changed                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents`       | Now a `ReadonlyMap<string, SubagentDiscoverySnapshot>`. The snapshot only carries id / name / namespace / status — **no** `messages` / `toolCalls` / `values`. Read those via selector hooks (§7). |
| `isThreadLoading` | Still exposed but now reflects the initial thread-load lifecycle rather than `fetchStateHistory`.                                                                                                  |

### 4.3 Removed — with replacements

| Legacy field                                                                    | v1 replacement                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch`, `setBranch`, `experimental_branchTree`                                | Branching is expressed as fork-from-checkpoint: call `useMessageMetadata(stream, msg.id)` to read the message's parent checkpoint and `submit(input, { forkFrom: { checkpointId } })` to fork. |
| `history`, `fetchStateHistory`                                                  | Dropped from the hook. Fetch history explicitly with `client.threads.getHistory(threadId)` if you need it; most apps do not.                                                                   |
| `getMessagesMetadata(msg, i)`                                                   | `useMessageMetadata(stream, msg.id)` returns `{ parentCheckpointId }` (see §6).                                                                                                                |
| `toolProgress`                                                                  | Dropped. Tool progress is now observable via `useToolCalls(stream)` — each `AssembledToolCall` carries its own `status`.                                                                       |
| `joinStream(runId, ...)`                                                        | Dropped. Remounting the hook with the right `threadId` rejoins automatically.                                                                                                                  |
| `switchThread(newThreadId)`                                                     | Drive `threadId` as a prop. The hook reloads on change: `setThreadId("new-id")`.                                                                                                               |
| `queue`                                                                         | `useSubmissionQueue(stream)` companion hook (see §6).                                                                                                                                          |
| `activeSubagents`, `getSubagent`, `getSubagentsByType`, `getSubagentsByMessage` | Iterate `stream.subagents` (a `Map`) and filter inline; every discovery snapshot carries `name`, `status`, `parentId`, `namespace`, and the tool-call id that spawned it.                      |

### 4.4 New fields

| Field             | Purpose                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subgraphs`       | `ReadonlyMap<string, SubgraphDiscoverySnapshot>` — subgraphs discovered on the thread (distinct from subagents).               |
| `subgraphsByNode` | `ReadonlyMap<string, SubgraphDiscoverySnapshot[]>` — same data keyed by graph node. Arrays to preserve parallel fan-out order. |

### 4.5 Worked example — minimal diff

```tsx
// Before
const {
  messages,
  isLoading,
  error,
  submit,
  branch,
  setBranch,
  getMessagesMetadata,
} = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  onError: (err) => console.error(err),
  fetchStateHistory: true,
});

// After
const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
const { messages, isLoading, error, submit } = stream;

useEffect(() => {
  if (error) console.error(error);
}, [error]);

// Branching → read the parent checkpoint off the message you want to fork from
const { parentCheckpointId } =
  useMessageMetadata(stream, messages.at(-1)?.id) ?? {};
```

---

## 5. `submit()` signature changes

### 5.1 Input widening

`submit()` now accepts **either** a wire-format message payload **or** an
array of `BaseMessage` class instances:

```tsx
// All three forms are valid:
await submit({ messages: [{ role: "user", content: "hi" }] });
await submit({ messages: [new HumanMessage("hi")] });
await submit({ messages: new HumanMessage("hi") });
```

This is driven by the new `WidenUpdateMessages<T>` helper (exported
publicly for prop-drilling scenarios; see §12). You do not need to
reach for it unless you're typing an intermediate variable.

### 5.2 Option changes

| Legacy `SubmitOptions` field                                                                                                                        | v1 `StreamSubmitOptions` equivalent                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.configurable`                                                                                                                               | `config.configurable` (unchanged)                                                                                                                                         |
| `context`                                                                                                                                           | Drop — fold into `config.configurable`.                                                                                                                                   |
| `checkpoint: { checkpoint_id }`                                                                                                                     | `forkFrom: { checkpointId }` (new, cleaner shape).                                                                                                                        |
| `command: { resume }`                                                                                                                               | Same. Additionally `{ goto, update }` are type-accepted for forward compatibility.                                                                                        |
| `interruptBefore`, `interruptAfter`                                                                                                                 | Drop — not supported in v2.                                                                                                                                               |
| `metadata`                                                                                                                                          | Unchanged.                                                                                                                                                                |
| `multitaskStrategy`                                                                                                                                 | Unchanged. `"rollback"` (default), `"reject"`, and `"enqueue"` are honoured client-side today; `"interrupt"` falls back to `"rollback"` pending server support (see §13). |
| `onCompletion`, `onDisconnect`, `feedbackKeys`, `streamMode`, `runId`, `optimisticValues`, `streamSubgraphs`, `streamResumable`, `checkpointDuring` | Drop. Most of these map to protocol-v2 defaults; `optimisticValues` has no client-side analogue — reconcile via `values` after the run settles.                           |
| **(new)** `onError`                                                                                                                                 | Per-submit fire-and-forget error callback. Fires only for the submission it was attached to. Transport-level `stream.error` updates still happen in parallel.             |
| **(new)** `threadId`                                                                                                                                | Per-submit thread override — rebinds the controller to the given thread before dispatching, then keeps it bound until the hook's `threadId` prop changes again.           |

```tsx
// Before
await submit(
  { messages: [new HumanMessage("retry")] },
  {
    checkpoint: { checkpoint_id: "cp_123" },
    multitaskStrategy: "rollback",
    optimisticValues: (prev) => ({ ...prev, pending: true }),
  },
);

// After
await submit(
  { messages: [new HumanMessage("retry")] },
  { forkFrom: { checkpointId: "cp_123" }, multitaskStrategy: "rollback" },
);
```

---

## 6. Companion selector hooks — the new mental model

Legacy `useStream` returned _everything_ in one object. v1 keeps the
always-on data on the root return and pushes the rest into **companion
selector hooks** that ref-count their server subscriptions. Mount them
where you render, unmount = automatic cleanup.

All of these are exported from `@langchain/react`:

| Hook                                              | Replaces                             | Notes                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useValues(stream)`                               | `stream.values`                      | Root form is a free read; scoped form (`useValues(stream, target)`) opens a namespaced subscription. Explicit generic: `useValues<State>(stream, sub)`. |
| `useMessages(stream)`                             | `stream.messages`                    | Same pattern. Scoped view yields subagent / subgraph messages without fan-out.                                                                          |
| `useToolCalls(stream)`                            | `stream.toolCalls`                   | Typed tool-call union is inferred from `typeof agent` or an explicit tools array.                                                                       |
| `useMessageMetadata(stream, msgId)`               | `stream.getMessagesMetadata(msg, i)` | Returns `{ parentCheckpointId } \| undefined`. Drives fork-from-checkpoint.                                                                             |
| `useSubmissionQueue(stream)`                      | `stream.queue`                       | Returns `{ entries, size, cancel(id), clear() }`. Backed by `multitaskStrategy: "enqueue"`.                                                             |
| `useExtension(stream, name)`                      | Per-event callbacks                  | Read a named protocol extension (custom channel).                                                                                                       |
| `useChannel(stream, channels)`                    | Raw event callbacks                  | Low-level escape hatch.                                                                                                                                 |
| `useAudio`, `useImages`, `useVideo`, `useFiles`   | —                                    | New, multimodal streaming.                                                                                                                              |
| `useMediaURL`, `useAudioPlayer`, `useVideoPlayer` | —                                    | Helpers built on top of the media hooks.                                                                                                                |

```tsx
// Before: everything on the root
const { messages, toolCalls, getMessagesMetadata, queue } = useStream({
  assistantId,
});

// After: always-on stays on the root; rest moves to selectors
const stream = useStream({ assistantId });
const messages = useMessages(stream); // or just stream.messages
const toolCalls = useToolCalls(stream); // or just stream.toolCalls
const metadata = useMessageMetadata(stream, messages.at(-1)?.id);
const { entries, size, cancel, clear } = useSubmissionQueue(stream);
```

### 6.1 Fork from message (the old `branch` flow)

```tsx
function EditButton({
  stream,
  message,
}: {
  stream: UseStreamReturn;
  message: BaseMessage;
}) {
  const metadata = useMessageMetadata(stream, message.id);

  return (
    <button
      disabled={!metadata?.parentCheckpointId}
      onClick={() =>
        stream.submit(
          { messages: [new HumanMessage("...revised prompt...")] },
          { forkFrom: { checkpointId: metadata!.parentCheckpointId } },
        )
      }
    >
      Edit from here
    </button>
  );
}
```

### 6.2 Enqueue-and-cancel (the old `queue` flow)

```tsx
function Composer({ stream }: { stream: UseStreamReturn }) {
  const { entries, cancel, clear } = useSubmissionQueue(stream);

  return (
    <>
      <button
        onClick={() =>
          stream.submit(
            { messages: [new HumanMessage("go")] },
            { multitaskStrategy: "enqueue" },
          )
        }
      >
        Queue turn
      </button>
      <ol>
        {entries.map((e) => (
          <li key={e.id}>
            pending… <button onClick={() => cancel(e.id)}>cancel</button>
          </li>
        ))}
      </ol>
      {entries.length > 0 && <button onClick={clear}>Clear queue</button>}
    </>
  );
}
```

---

## 7. Subagents & subgraphs

### 7.1 Discovery

Subagents and subgraphs are now **discovered eagerly but streamed
lazily**. The discovery maps (`stream.subagents`,
`stream.subgraphs`, `stream.subgraphsByNode`) are kept in sync with
zero extra wire cost; each snapshot exposes identity fields only:

```ts
interface SubagentDiscoverySnapshot {
  readonly id: string; // tool-call id that spawned it
  readonly name: string; // "researcher", "writer", …
  readonly namespace: readonly string[];
  readonly parentId: string | null;
  readonly depth: number;
  readonly status: "pending" | "running" | "complete" | "error";
  // — no messages / toolCalls / values. Use selector hooks below.
}
```

### 7.2 Per-subagent content

Replace every `subagent.messages` / `subagent.toolCalls` / `subagent.values`
read with the matching selector, passing the discovery snapshot:

```tsx
// Before
{
  [...stream.subagents.values()].map((s) => (
    <SubagentCard key={s.id} messages={s.messages} toolCalls={s.toolCalls} />
  ));
}

// After
{
  [...stream.subagents.values()].map((s) => (
    <SubagentCard key={s.id} stream={stream} subagent={s} />
  ));
}

function SubagentCard({ stream, subagent }) {
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);
  const values = useValues<ResearcherState>(stream, subagent);
  // …
}
```

The first time any component mounts `useMessages(stream, subagent)` a
`messages`-channel subscription is opened, scoped to
`subagent.namespace`. When the last consumer unmounts, the subscription
is released automatically. This is the single biggest wire-cost win of
the new design — views that don't render a subagent's messages never
pay for them.

### 7.3 Removed helpers

`activeSubagents`, `getSubagent(id)`, `getSubagentsByType(name)`, and
`getSubagentsByMessage(msg)` are gone. Derive the equivalents inline:

```ts
const active = [...stream.subagents.values()].filter(
  (s) => s.status === "running",
);
const researcher = [...stream.subagents.values()].find(
  (s) => s.name === "researcher",
);
const byType = new Map<string, SubagentDiscoverySnapshot[]>();
for (const s of stream.subagents.values()) {
  const bucket = byType.get(s.name) ?? [];
  bucket.push(s);
  byType.set(s.name, bucket);
}
```

---

## 8. Headless tools (`tools` + `onTool`)

The legacy `tools` / `onTool` options are preserved one-for-one. The
root hook listens for interrupt payloads that target a registered tool,
invokes the handler, and auto-resumes the run with the handler's return
value — exactly the pre-v1 behaviour. A StrictMode-safe dedupe guard
prevents double invocation when the same interrupt is observed twice.

```tsx
const stream = useStream({
  assistantId: "deep-agent",
  tools: [getCurrentLocation, confirmAction],
  onTool: (event) => {
    if (event.type === "error") logger.error(event.error);
  },
});
```

No migration is needed if you were already using this API. The helper
exports (`flushPendingHeadlessToolInterrupts`, `findHeadlessTool`,
`handleHeadlessToolInterrupt`, …) are still available from
`@langchain/react` for advanced flows that compose their own interrupt
handling.

---

## 9. Custom transports: `UseStreamTransport` → `AgentServerAdapter`

The legacy custom-transport surface looked like:

```ts
interface UseStreamTransport<S, Bag> {
  stream(payload: UseStreamTransportPayload<S, Bag>): Promise<
    AsyncGenerator<{ id?: string; event: string; data: unknown }>
  >;
}

// The convenience class that implemented it:
class FetchStreamTransport implements UseStreamTransport { ... }
```

v1 replaces this with `AgentServerAdapter`, a richer interface that
owns the **entire** transport — both commands and the event stream —
and matches the v2 protocol's request shape. There is a convenience
class `HttpAgentServerAdapter` that covers the common case (SSE + WS
with injectable `fetch` / `webSocketFactory` / `defaultHeaders`).

### 9.1 Most apps: drop in `HttpAgentServerAdapter`

```tsx
// Before
import { FetchStreamTransport, useStream } from "@langchain/react";

const transport = new FetchStreamTransport({ apiUrl: "/api/chat" });
const stream = useStream({ transport });

// After
import { HttpAgentServerAdapter, useStream } from "@langchain/react";

const transport = new HttpAgentServerAdapter({
  apiUrl: "/api/chat",
  threadId: "thread-123", // required: the adapter is bound to a thread
  defaultHeaders: { Authorization: `Bearer ${token}` },
  // Optional: fetch override or webSocketFactory for WebSocket transports
  fetch: myAuthedFetch,
});
const stream = useStream({ transport });
```

### 9.2 Custom implementations

If you hand-rolled a `UseStreamTransport`, migrate to
`AgentServerAdapter`:

```ts
interface AgentServerAdapter {
  readonly threadId: string;
  open(): Promise<void>;
  send(command: Command, options: { signal?: AbortSignal }): Promise<void>;
  subscribe(options: {
    onEvent: (event: ProtocolEvent) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;

  // Optional — implement if your server supports them:
  getState?(): Promise<ThreadState>;
  getHistory?(options?): Promise<ThreadState[]>;
  openEventStream?(options?): Promise<ReadableStream<Uint8Array>>;
}
```

The adapter is used exactly as-is; the LGP `Client` is _not_
constructed when a custom adapter is supplied, so bundles that only
use a custom adapter tree-shake the entire `sse`/`websocket` transport
stack.

### 9.3 Discriminated options

Passing both `assistantId` + `apiUrl` **and** a `transport:
AgentServerAdapter` is now a compile-time error:

```ts
useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  transport: myAdapter, // ❌ `apiUrl` is `never` on the custom-adapter branch
});
```

Pick one branch per `useStream` instance.

---

## 10. `StreamProvider` / `useStreamContext`

The provider and consumer are unchanged at the call site — the
provider wraps whatever `useStream` returns and publishes it over React
context:

```tsx
<StreamProvider assistantId="agent" apiUrl="http://localhost:2024">
  <Chat />
</StreamProvider>;

function Chat() {
  const { messages, submit } = useStreamContext();
  // …
}
```

Because the underlying `useStream` changed, the context value changes
accordingly — any destructuring in consumers must be updated per §4.
Generic usage (`useStreamContext<typeof agent>()`) propagates the
`typeof agent` inference through to `values` / `toolCalls` /
`subagents` automatically.

`StreamProviderProps<T>` (LGP branch) and `StreamProviderCustomProps<T>`
(custom-adapter branch) mirror the two arms of the `useStream` options
union; pass `transport: adapter` to route through a custom
`AgentServerAdapter`.

---

## 11. `useSuspenseStream`

`useSuspenseStream` is now a slim v1-native port built on top of
`useStream` and the controller's `hydrationPromise`. The legacy
implementation prefetched `threads.getHistory(threadId)` into an
external `SuspenseCache`; v1 drops `history` entirely and uses the
controller's hydration lifecycle directly.

### 11.1 What was dropped

| Legacy surface                                                           | v1 replacement                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `SuspenseCache`, `createSuspenseCache`, `invalidateSuspenseCache`        | Gone. The hook uses a module-level cache keyed on `(apiUrl, assistantId, threadId)`.     |
| `suspenseCache` option                                                   | Gone. No caller-side setup required.                                                     |
| `fetchStateHistory: { limit }` prefetch                                  | Gone. The v1 hook hydrates via `threads.getState()` and suspends until that settles.     |
| `branch` / `setBranch` / `history` / `getMessagesMetadata` on the return | Gone from the suspense hook, same as plain `useStream`. Use the companion hooks from §6. |

### 11.2 Return shape

`UseSuspenseStreamReturn<T>` is `UseStreamReturn<T>` with:

- `isLoading`, `isThreadLoading`, `hydrationPromise` **removed**
  (Suspense handles those phases).
- `isStreaming: boolean` **added** — `true` while tokens are
  arriving, so you can render a typing indicator distinct from the
  suspended initial-load state.
- Non-streaming errors are thrown to the nearest Error Boundary
  instead of surfacing via `error`.

All other fields (`values`, `messages`, `toolCalls`, `interrupts`,
`subagents`, `subgraphs`, `submit`, `stop`, `respond`, …) are
identical to `useStream`'s return.

### 11.3 Minimal usage

```tsx
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useSuspenseStream } from "@langchain/react";

function App() {
  return (
    <ErrorBoundary fallback={<ErrorDisplay />}>
      <Suspense fallback={<Spinner />}>
        <Chat />
      </Suspense>
    </ErrorBoundary>
  );
}

function Chat() {
  const { messages, submit, isStreaming } = useSuspenseStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    threadId,
  });
  return <MessageList messages={messages} streaming={isStreaming} />;
}
```

Thread switching works naturally — changing the `threadId` prop
re-suspends the component while the new thread hydrates.

---

## 12. Type helpers

The v1 package exports a small set of type helpers you reach for when
prop-drilling a stream handle:

| Helper                                                                                                                 | Use                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `UseStreamReturn<T>`                                                                                                   | The fully-resolved return type of `useStream<T>`. Prop-drill as `{ stream: UseStreamReturn<typeof agent> }`.                     |
| `AnyStream`                                                                                                            | Type-erased handle (`UseStreamExperimentalReturn<any, any, any>`) for components that only forward the stream to selector hooks. |
| `InferStateType<T>`                                                                                                    | Unwraps a compiled graph / agent brand / agent tool array into its state shape.                                                  |
| `InferToolCalls<T>`                                                                                                    | Derives a discriminated union of tool-call shapes from tools array, agent brand, or an explicit shape.                           |
| `InferSubagentStates<T>`                                                                                               | `{ name: State, … }` map derived from a DeepAgent brand.                                                                         |
| `WidenUpdateMessages<T>`                                                                                               | Widens `messages` in a partial state update so both wire-format and `BaseMessage` instances typecheck in `submit()`.             |
| `StreamSubmitOptions<State, Configurable>`                                                                             | Options shape accepted by `submit()`.                                                                                            |
| `AgentServerAdapter`                                                                                                   | Interface for custom transports (see §9).                                                                                        |
| `HttpAgentServerAdapter`, `HttpAgentServerAdapterOptions`                                                              | Convenience adapter (see §9).                                                                                                    |
| `UseStreamExperimentalOptions`, `AgentServerOptions`, `CustomAdapterOptions`                                           | Discriminated options union; rarely needed at call sites.                                                                        |
| `SelectorTarget`, `SubagentDiscoverySnapshot`, `SubgraphDiscoverySnapshot`                                             | For components that render per-subagent/subgraph views.                                                                          |
| `AssembledToolCall`, `ToolCallStatus`                                                                                  | For rendering tool-call UI.                                                                                                      |
| `MessageMetadata`, `MessageMetadataMap`, `UseSubmissionQueueReturn`, `SubmissionQueueEntry`, `SubmissionQueueSnapshot` | Companion-hook return shapes.                                                                                                    |

### 12.1 Legacy type aliases (removed)

**Breaking change:** the legacy type aliases that used to be
re-exported from `@langchain/react` are **no longer available from
this package**. The following names are gone:

`UseStream`, `UseSuspenseStream`, `UseStreamCustom`, `UseStreamOptions`,
`UseStreamCustomOptions`, `UseStreamTransport`, `UseStreamThread`,
`GetToolCallsType`, `QueueEntry`, `QueueInterface`,
`SubagentStream`, `SubagentStreamInterface`,
`BaseSubagentState`, `SubagentStateMap`, `DefaultSubagentStates`,
`InferAgentToolCalls`, `InferDeepAgentSubagents`,
`InferSubagentByName`, `InferSubagentNames`, `InferSubagentState`,
`SubAgentLike`, `CompiledSubAgentLike`, `DeepAgentTypeConfigLike`,
`AgentTypeConfigLike`, `IsAgentLike`, `IsDeepAgentLike`,
`ExtractAgentConfig`, `ExtractDeepAgentConfig`,
`ExtractSubAgentMiddleware`, `SubagentToolCall`, `SubagentStatus`,
`ClassSubagentStreamInterface`, `FetchStreamTransport`.

Migrate each call site to the v1 name:

| Legacy name                                 | v1 replacement                                                      |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `UseStream<State, Bag>`                     | `UseStreamReturn<State>` (or `UseStreamReturn<typeof agent>`).      |
| `UseStreamOptions<State, Bag>`              | `UseStreamExperimentalOptions<State>` (or just let the hook infer). |
| `UseStreamTransport`                        | `AgentServerAdapter` (§9).                                          |
| `FetchStreamTransport`                      | `HttpAgentServerAdapter` (§9).                                      |
| `GetToolCallsType<State>`                   | `InferToolCalls<typeof agent>`.                                     |
| `UseSuspenseStream<…>`                      | `UseSuspenseStreamReturn<T>` (v1-native shape — see §11).           |
| `QueueEntry`, `QueueInterface`              | `SubmissionQueueEntry`, `UseSubmissionQueueReturn` (§6).            |
| `SubagentStream`, `SubagentStreamInterface` | `SubagentDiscoverySnapshot` + `useMessages(stream, subagent)` (§7). |

Apps that cannot migrate all call sites in one pass can keep using the
legacy types by importing them directly from
`@langchain/langgraph-sdk/ui` during the transition — but mixing
legacy and v1 types on the same `useStream` result will not
typecheck.

### 12.2 `MessageMetadata` collision

**Breaking change:** `@langchain/react` v1 exports a new
`MessageMetadata` from `@langchain/langgraph-sdk/stream` with a
different shape (`{ parentCheckpointId }`) than the legacy one
(`{ messageId, firstSeenState, branch, branchOptions }`). Legacy call
sites must import the legacy type directly:

```ts
// Before
import type { MessageMetadata } from "@langchain/react";

// After (only if you still need the legacy shape)
import type { MessageMetadata } from "@langchain/langgraph-sdk/ui";
```

---

## 13. Known gaps & server-side prerequisites

Some v1 type-level features are _accepted_ but not yet _executed_ end-
to-end — they are wired through the client and will activate once the
matching server-side protocol work ships. This matters if you are on
self-hosted LangGraph or a pinned server version.

| Feature                                         | Status today                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `submit(input, { forkFrom: { checkpointId } })` | Type-accepted; forwarded on `/run.input`. Requires the server-side `forkFrom` path to be honoured (roadmap item A0.1).                                                                                                                     |
| `submit(null, { command: { goto, update } })`   | Type-accepted; forwarded on `/run.input`. Only `command.resume` is executed client-side today.                                                                                                                                             |
| `multitaskStrategy: "enqueue"`                  | **Fully honoured client-side.** The controller records the submission in `queueStore`, exposes it via `useSubmissionQueue(stream)`, and drains queued entries sequentially after each run settles. Server-native queueing lands with A0.3. |
| `multitaskStrategy: "reject"`                   | Fully honoured client-side — `submit()` throws when a run is already in flight.                                                                                                                                                            |
| `multitaskStrategy: "rollback"` (default)       | Fully honoured client-side — the in-flight run is aborted and the new submission dispatches immediately.                                                                                                                                   |
| `multitaskStrategy: "interrupt"`                | Type-accepted. Falls back to `"rollback"` behaviour until server-side interrupt semantics land (A0.3).                                                                                                                                     |
| `useMessageMetadata().parentCheckpointId`       | Populated from the `parent_checkpoint` field on `values` events. Requires the server to emit that field (roadmap item A0.2).                                                                                                               |

Until those land, the client-side scaffolding is a no-op for the
relevant field rather than a crash — code written against the v1
surface will start to function the moment the server catches up.

---

## 14. FAQ

### Q. We still need a raw event stream for analytics. What replaces `onLangChainEvent` / `onDebugEvent` / `onCustomEvent`?

Use `useChannel(stream, channels)` for a bounded buffer of raw events
scoped to a namespace, or subscribe to a specific extension with
`useExtension(stream, name)`. For app-wide telemetry, pipe the raw
stream through a custom `AgentServerAdapter` (§9) and tee events to
your analytics sink there.

### Q. My backend only emits `values` events (no `messages` channel). Will streaming still work?

Yes — `stream.messages` merges `messages`-channel deltas _and_
`values.messages` snapshots. Backends that only emit values will
render full turns at once instead of token-by-token. This is a backend
concern; the React layer faithfully renders whatever the server sends.

### Q. We pinned `@langchain/langgraph-sdk` in app code. Do we need to bump it?

Yes. `@langchain/react` v1 depends on the v2 stream runtime in
`@langchain/langgraph-sdk`. Bumping the SDK is mandatory, but the
public v1 type helpers (`InferStateType`, `AgentServerAdapter`, …)
are re-exported from `@langchain/react` so app imports rarely need to
reach into the SDK directly.

### Q. How do I migrate a `useStream` call that was deeply generic (`useStream<State, Bag>`)?

v1 takes three generics: `useStream<T, InterruptType, ConfigurableType>`
where `T` is **either** a plain state shape **or** an agent brand
(`typeof agent`). The legacy `Bag` options (`UpdateType`,
`CustomEventType`, `MetaType`) are gone — widening is automatic for
messages, and update / custom / meta shapes are no longer tracked by
type. If you passed `InterruptType` via `Bag`, lift it to the second
generic slot.

```ts
// Before
useStream<MyState, { InterruptType: MyInterrupt }>({ ... });

// After
useStream<MyState, MyInterrupt>({ ... });
```

### Q. Is the `useStreamExperimental` name going away?

Yes — but not in v1.0. `useStreamExperimental` is kept as a thin
alias of `useStream` so apps that adopted the preview can bump to
v1 without touching imports. It will be removed in the next minor;
new code should import `useStream`.

### Q. Where did the legacy `useStream` / `FetchStreamTransport` surface go?

The legacy source files (`stream.tsx`, `stream.lgp.tsx`,
`stream.custom.tsx`, `types.tsx`, `suspense-stream.tsx`) and every
legacy type re-export have been removed from `@langchain/react` v1.
In particular:

- `import { FetchStreamTransport } from "@langchain/react"` no longer
  resolves — use `HttpAgentServerAdapter` from the same package (§9).
- The legacy type aliases (`UseStream`, `UseStreamOptions`,
  `UseStreamTransport`, `QueueEntry`, `SubagentStream`, …) are no
  longer re-exported; use the v1 names from §12.
- `useSuspenseStream` is now a slim v1-native port (§11).

Apps that still need the legacy types mid-migration can import them
directly from `@langchain/langgraph-sdk/ui`. No runtime code in the
legacy surface remains in the `@langchain/react` bundle.

### Q. Does `multitaskStrategy: "enqueue"` work today?

Yes, end-to-end on the client. Submissions issued with `{
multitaskStrategy: "enqueue" }` while another run is in flight are
recorded in the controller's `queueStore`, exposed via
`useSubmissionQueue(stream)` (with `cancel(id)` / `clear()`
affordances), and drained sequentially once the active run settles.
Switching threads clears the queue. Server-native queueing lands in
roadmap item A0.3; until then, page reload discards pending entries
(they are not persisted).

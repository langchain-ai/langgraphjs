# `useStreamExperimental` — v2-native React binding (design + implementation)

**Status:** implemented (experimental, unstable API)
**Owners:** `@langchain/react`
**Entry points:**
  `import { useStreamExperimental, useMessages, useToolCalls, useValues, useExtension, useChannel } from "@langchain/react"`

**Framework-agnostic core:**
  `import { StreamController, ChannelRegistry, messagesProjection, ... } from "@langchain/langgraph-sdk/stream"`

---

## 0. Implementation status

Everything described below is implemented and typechecks cleanly. The
code split is designed for reuse by Vue / Svelte / Angular bindings
— the React package owns **only** the hooks; every piece of state,
subscription management, and assembly lives in the framework-free SDK
subpath.

### 0.1 What lives where

| Layer | Location | Depends on React? |
| --- | --- | --- |
| `StreamStore<T>` — minimal observable | `libs/sdk/src/stream-experimental/store.ts` | no |
| `ChannelRegistry` — ref-counted subscription cache | `libs/sdk/src/stream-experimental/channel-registry.ts` | no |
| `StreamController` — thread lifecycle + root projections + discovery | `libs/sdk/src/stream-experimental/controller.ts` | no |
| `SubagentDiscovery` / `SubgraphDiscovery` | `libs/sdk/src/stream-experimental/discovery/*` | no |
| Projection factories (`messages`, `toolCalls`, `values`, `extension`, `channel`) | `libs/sdk/src/stream-experimental/projections/*` | no |
| `assembledToBaseMessage` — assembled-message → `BaseMessage` class instance | `libs/sdk/src/stream-experimental/assembled-to-message.ts` | no |
| `useProjection` — composes `ChannelRegistry.acquire` with `useSyncExternalStore` | `libs/sdk-react/src/stream-experimental/use-projection.ts` | yes |
| `useStreamExperimental` — thread-centric root hook | `libs/sdk-react/src/stream-experimental/use-stream-experimental.ts` | yes |
| Selector hooks (`useMessages`, `useToolCalls`, `useValues`, `useExtension`, `useChannel`) | `libs/sdk-react/src/stream-experimental/selectors.ts` | yes |

### 0.2 Porting to Vue / Svelte / Angular

Every port only needs to re-implement **three tiny React-shaped
pieces**:

1. **`useProjection` equivalent** — wraps `ChannelRegistry.acquire` in
   the framework's mount/unmount lifecycle:
   - Vue: `setup()` + `onScopeDispose`.
   - Svelte: `$effect` + return disposer.
   - Angular: `DestroyRef.onDestroy` inside a signal `effect()`.
2. **`useStreamExperimental` equivalent** — constructs one
   `StreamController` per component scope and binds the three
   always-on stores (`rootStore`, `subagentStore`, `subgraphStore`)
   to the framework's reactivity primitive
   (`ref`/`shallowRef`/`signal`/`writable`).
3. **Selector functions** — identical signatures, each one is a
   4-line wrapper over `useProjection` + the relevant projection
   factory.

The public API surface (selector signatures, `SelectorTarget` shape,
return types) is identical across frameworks. Messages are always
`BaseMessage` class instances. Nothing framework-specific leaks into
the SDK subpath.

### 0.3 Known gaps (see §10 for the full list)

- `branch` / `setBranch` / `history` / `experimental_branchTree` — not
  wired yet; v2 checkpointer integration comes next.
- `getMessagesMetadata` — not yet mapped; shape decision pending.
- `joinStream` — waiting on server-side v2 replay semantics.

---

## 1. Why this design

The v1 `useStream` hook ships one reducer per projection and opens
every channel proactively. The v2 protocol already assembles
`values` / `messages` / `toolCalls` / `subagents` / `subgraphs` on
the SDK side and scopes subscriptions by `namespace`. The job of
the React binding is to:

- expose those assembled projections as React values,
- open the underlying server subscription **only** when a
  component on screen is rendering the value, and
- close it when no component needs it anymore.

Previous iterations of this hook tried to solve that with an
imperative `watchSubagent()` method or a global
`subagentProjections` flag. Both push lifecycle management onto
consumers and don't generalise to subgraphs, custom extensions,
or raw channels.

The refined design treats **every protocol projection as a
selector hook**. Using the hook in render is the subscription
request. React's mount/unmount lifecycle is the teardown.

---

## 2. Design principles

1. **Render = subscribe, unmount = unsubscribe.**
   A component that renders a projection value automatically
   opens a namespace-scoped subscription for its lifetime.
2. **Ref-counted coalescing.**
   Ten components watching the same `(channel, namespace)` share
   one server subscription. The last one to unmount closes it.
3. **Unified hook surface.**
   One `useMessages(stream, target?)` works for root, subagents,
   subgraphs, or any arbitrary namespace. Same for
   `useToolCalls`, `useValues`, `useExtension`, `useChannel`.
4. **Class-instance messages only.**
   Every message surfaced by any hook is a `BaseMessage` class
   instance from `@langchain/core/messages`. The plain `Message`
   interface (`libs/sdk/src/types.messages.ts`) is internal-only
   and never reaches the public API.
5. **Discovery is cheap and always-on.**
   `stream.subagents` and `stream.subgraphs` are populated via a
   single shared root subscription. Discovery info (id, name,
   status, namespace, startedAt, completedAt) is available with
   zero extra cost. The *contents* of each subagent/subgraph
   (messages, tool calls, custom channels) live behind selector
   hooks.
6. **Honest types.**
   `stream.subagents.get(id).messages` does not exist. There is
   no lie about "sometimes populated". If you want the messages,
   you call `useMessages(stream, subagent)`.

---

## 3. Mental model

Every projection is addressed by two things:

- **Kind** — `messages`, `toolCalls`, `values`, `custom:<name>`,
  or a raw channel list.
- **Target** — *where* in the run tree to read it from.
  Encoded as a namespace (`string[]`). Root = `[]`.

A selector hook is the pairing:

```
useMessages(stream, target?)        → BaseMessage[]
useToolCalls(stream, target?)       → ToolCallWithResult[]
useValues<T>(stream, target?)       → T
useExtension<T>(stream, name, t?)   → T
useChannel(stream, channels, t?)    → Event[]    // raw escape hatch
```

`target` is duck-typed on a `namespace` field. Any object with a
`readonly namespace: string[]` works — which means you can pass a
`SubagentDiscoverySnapshot`, a `SubgraphDiscoverySnapshot`, or a
hand-built `{ namespace: [...] }`. Omit for root.

```ts
type Target = undefined | { readonly namespace: readonly string[] };
```

---

## 4. Public API

### 4.1 Hook

```ts
interface UseStreamExperimentalOptions<StateType> {
  assistantId: string;
  threadId?: string | null;
  client?: Client;
  apiUrl?: string;
  apiKey?: string;
  callerOptions?: ClientConfig["callerOptions"];
  defaultHeaders?: ClientConfig["defaultHeaders"];
  transport?: "sse" | "websocket";
  fetch?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  onThreadId?: (threadId: string) => void;
  onCreated?: (meta: { run_id: string; thread_id: string }) => void;
  initialValues?: StateType;
  messagesKey?: string;
}

interface UseStreamExperimentalReturn<StateType, Bag> {
  // Always-on root projections. One shared subscription each,
  // opened when the first consumer of the top-level hook mounts.
  // These are the cheap ones — every app uses them.
  readonly values: StateType;
  readonly messages: BaseMessage[];               // class instances
  readonly toolCalls: ToolCallWithResult[];
  readonly interrupts: Interrupt[];
  readonly interrupt: Interrupt | undefined;      // interrupts[0]
  readonly isLoading: boolean;
  readonly isThreadLoading: boolean;
  readonly error: unknown;

  // Discovery maps. Populated from root-level events, no inner
  // channels open. `messages` / `toolCalls` are not on these
  // snapshots — use the scoped hooks instead.
  readonly subagents: ReadonlyMap<string, SubagentDiscoverySnapshot>;
  readonly subgraphs: ReadonlyMap<string, SubgraphDiscoverySnapshot>;

  // Imperatives.
  submit(input: UpdateType | null | undefined, opts?: SubmitOptions): Promise<void>;
  stop(): Promise<void>;
  respond(response: unknown, target?: { interruptId: string; namespace?: string[] }): Promise<void>;
  joinStream(runId: string): Promise<void>;
  getThread(): ThreadStream | undefined;        // v2 escape hatch

  readonly client: Client;
  readonly assistantId: string;
}

interface SubagentDiscoverySnapshot {
  readonly id: string;                      // tool-call id
  readonly name: string;                    // subagent_type
  readonly namespace: readonly string[];
  readonly parentId: string | null;
  readonly depth: number;
  readonly status: "running" | "complete" | "error";
  readonly taskInput: string | undefined;
  readonly output: unknown;                 // resolved from handle.output
  readonly error: string | undefined;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

interface SubgraphDiscoverySnapshot {
  readonly id: string;
  readonly namespace: readonly string[];
  readonly status: "running" | "complete" | "error";
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}
```

### 4.2 Selector hooks

```ts
// BaseMessage class instances — always. Pass a SubagentDiscoverySnapshot
// or SubgraphDiscoverySnapshot to scope to that namespace.
function useMessages(
  stream: UseStreamExperimentalReturn<any, any>,
  target?: Target,
): BaseMessage[];

function useToolCalls(
  stream: UseStreamExperimentalReturn<any, any>,
  target?: Target,
): ToolCallWithResult[];

function useValues<T = unknown>(
  stream: UseStreamExperimentalReturn<any, any>,
  target?: Target,
): T;

// Typed custom channel (`custom:<name>`).
function useExtension<T = unknown>(
  stream: UseStreamExperimentalReturn<any, any>,
  name: string,
  target?: Target,
): T | undefined;

// Raw escape hatch — returns `Event[]` for anything else.
function useChannel(
  stream: UseStreamExperimentalReturn<any, any>,
  channels: Channel | readonly Channel[],
  target?: Target,
): Event[];
```

All hooks share the same lifetime contract: subscribe on first
render, hold one shared subscription per `(channels, namespace)`
across all mounted consumers, unsubscribe when the last consumer
unmounts.

### 4.3 Identity rule for `target`

Hooks key their subscription off `JSON.stringify(target?.namespace ?? [])`
plus the channel set. Passing `stream.subagents.get(id)` and
`stream.subagents.get(id)` in two components therefore collapses
onto one subscription even though the snapshot objects are
`useSyncExternalStore`-updated each render. The reference of the
snapshot doesn't matter; its `namespace` content does.

---

## 5. Example usage

### 5.1 Root messages + subagent discovery

```tsx
function App() {
  const stream = useStreamExperimental<MyState>({
    assistantId: "deep-agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <>
      <ChatBubbles messages={stream.messages} />

      <SubagentList>
        {[...stream.subagents.values()].map(sub => (
          <SubagentCard key={sub.id} stream={stream} subagent={sub} />
        ))}
      </SubagentList>

      {stream.interrupt && (
        <ApprovalPrompt
          value={stream.interrupt.value}
          onApprove={() => stream.respond({ approved: true })}
        />
      )}
    </>
  );
}
```

`stream.messages` is populated eagerly (always-on root
subscription). `stream.subagents` is populated from root-level
`tools` + `lifecycle` events (also always-on). Zero
per-subagent channels are open at this point.

### 5.2 Rendering a subagent — opens messages + tools for that subagent only

```tsx
function SubagentCard({ stream, subagent }: {
  stream: UseStreamExperimentalReturn<MyState, MyBag>;
  subagent: SubagentDiscoverySnapshot;
}) {
  // Mount → open messages + tools channels scoped to subagent.namespace.
  // Unmount → close them. Two cards for the same subagent share one
  // subscription each.
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);

  return (
    <div>
      <h4>{subagent.name} — {subagent.status}</h4>
      <MessageList messages={messages} />      {/* BaseMessage[] */}
      <ToolCallList calls={toolCalls} />
    </div>
  );
}
```

### 5.3 Subgraph view

Identical shape — pass a subgraph snapshot instead:

```tsx
function SubgraphPane({ stream, subgraph }: {
  stream: UseStreamExperimentalReturn<MyState, MyBag>;
  subgraph: SubgraphDiscoverySnapshot;
}) {
  const messages = useMessages(stream, subgraph);
  const values = useValues<SubgraphState>(stream, subgraph);
  return (
    <>
      <MessageList messages={messages} />
      <StateInspector values={values} />
    </>
  );
}
```

### 5.4 Custom stream extension

```tsx
function ProgressBar({ stream, subagent }: {
  stream: UseStreamExperimentalReturn<MyState, MyBag>;
  subagent: SubagentDiscoverySnapshot;
}) {
  const progress = useExtension<{ percent: number }>(
    stream,
    "progress",
    subagent,
  );
  return <Bar value={progress?.percent ?? 0} />;
}
```

Same pattern — the `custom:progress` channel is opened only while
`<ProgressBar>` is mounted, and only scoped to the subagent that
emitted it. Omit `subagent` to subscribe at the thread root.

### 5.5 Raw channel escape hatch

```tsx
function RawEvents({ stream }: { stream: UseStreamExperimentalReturn<MyState, MyBag> }) {
  const events = useChannel(stream, ["lifecycle", "input"]);
  return <pre>{JSON.stringify(events, null, 2)}</pre>;
}
```

---

## 6. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ useStreamExperimental                                           │
│                                                                 │
│   useMemo → StreamController (owns ThreadStream, submit/stop)   │
│   useMemo → ChannelRegistry   (ref-counted subscription cache)  │
│                                                                 │
│   useEffect: controller.subscribeThread(t =>                    │
│              registry.bind(t))                                  │
│                                                                 │
│   // root projections: always-on                                │
│   useProjection(registry, { channels: ["values","lifecycle",    │
│                 "input","messages","tools"] , namespace: [] })  │
│                                                                 │
│   returns UseStreamExperimentalReturn (+ private _registry)     │
└─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ ChannelRegistry  (framework-agnostic, lives in @langchain/sdk)  │
│                                                                 │
│   private cache: Map<Key, Entry>                                │
│   private bound: ThreadStream | undefined                       │
│                                                                 │
│   bind(thread)   /  unbind()                                    │
│                                                                 │
│   acquire(spec): {                                              │
│     store: StreamStore<T>,                                      │
│     release(): void                                             │
│   }                                                             │
│                                                                 │
│   // spec = { kind, channels, namespace, name? }                │
│   // Key = hash(kind, channels.sorted, namespace.join("|"),     │
│   //              name ?? "")                                   │
│   //                                                            │
│   // On first acquire per key: open one                         │
│   //   thread.subscribe(channels, { namespaces: [namespace] })  │
│   //   and pipe events through the kind-specific assembler      │
│   //   into an internal StreamStore.                            │
│   //                                                            │
│   // On release → refcount--; if 0 →                            │
│   //   subscription.unsubscribe(); cache.delete(key)            │
└─────────────────────────────────────────────────────────────────┘
             ▲
             │ React glue
┌─────────────────────────────────────────────────────────────────┐
│ useProjection<T>(registry, spec): T                             │
│                                                                 │
│   const [entry, setEntry] = useState(() => registry.acquire(    │
│     spec))                                                      │
│   useEffect(() => {                                             │
│     // re-acquire when spec key changes                         │
│     const next = registry.acquire(spec)                         │
│     setEntry(next)                                              │
│     return () => next.release()                                 │
│   }, [keyOf(spec)])                                             │
│                                                                 │
│   return useSyncExternalStore(                                  │
│     entry.store.subscribe,                                      │
│     entry.store.getSnapshot,                                    │
│     entry.store.getSnapshot,                                    │
│   )                                                             │
│                                                                 │
│ Every typed hook (useMessages, useToolCalls, useValues,         │
│ useExtension, useChannel) is a one-liner over useProjection.    │
└─────────────────────────────────────────────────────────────────┘
```

### 6.1 ChannelRegistry internals — per-kind assembly

Each entry runs the matching assembler so the store's value type
matches the hook's return type:

| Kind       | Channels                                | Store value                 |
| ---------- | --------------------------------------- | --------------------------- |
| messages   | `["messages"]`                          | `BaseMessage[]`             |
| toolCalls  | `["tools"]`                             | `AssembledToolCall[]`       |
| values     | `["values"]`                            | `unknown` (caller casts)    |
| extension  | `["custom:<name>"]`                     | last-seen payload           |
| raw        | caller-provided                         | `Event[]` (bounded buffer)  |

Reducers are pure and live in `libs/sdk/src/stream-experimental/projections/`.
`messages` uses `StreamingMessageAssembler` and then calls
`assembledToBaseMessage()` (see §9) to produce class instances.

### 6.2 Lifecycle

```
 first acquire            last release
 ─────────────▶  [open]  ─────────────▶  [closed]
        ▲                                    │
        └─────── thread swap (registry.bind) ┘

 On thread swap:
   • for every live entry: unsubscribe on the old thread,
     open an equivalent subscription on the new thread,
     keep the same store reference.
   • React consumers don't re-mount; they see a transient
     empty snapshot while the new subscription hydrates,
     then updates start flowing again.
```

### 6.3 Why not cache on the SDK handles

`SubagentHandle.messages` / `.toolCalls` are lazy SDK getters but
**cache their iterables** — once iterated, the subscription is
sticky for the lifetime of the handle with no public close.
That's intentional for direct SDK users but breaks our
"unmount = unsubscribe" contract.

The registry therefore calls `thread.subscribe(channels, {
namespaces: [target.namespace] })` directly, mounts its own
assembler, and keeps the `SubscriptionHandle` so it can call
`.unsubscribe()` on ref-drop. No SDK change required.

---

## 7. Public API surface

```ts
// from @langchain/react
export { useStreamExperimental };
export { useMessages, useToolCalls, useValues, useExtension, useChannel };
export type {
  UseStreamExperimentalOptions,
  UseStreamExperimentalReturn,
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
  Target,
};
```

No `useSubagent`, no `useSubagentMessages`, no
`useSubagentToolCalls`. Subagents aren't a kind of subscription —
they're one of several possible *targets* for the generic
projection hooks.

---

## 8. Migration from v1 `useStream`

| v1                                                | v2                                                        |
| ------------------------------------------------- | --------------------------------------------------------- |
| `const stream = useStream({...})`                 | `const stream = useStreamExperimental({...})`             |
| `stream.messages` (plain `Message[]`)             | `stream.messages` (**`BaseMessage[]`**)                   |
| `stream.toolCalls`                                | `stream.toolCalls`                                        |
| `stream.interrupt` / `stream.interrupts`          | unchanged                                                 |
| `stream.subagents.get(id)`                        | `stream.subagents.get(id)` — **discovery only**           |
| `stream.subagents.get(id).messages`               | `useMessages(stream, stream.subagents.get(id))`           |
| `stream.subagents.get(id).toolCalls`              | `useToolCalls(stream, stream.subagents.get(id))`          |
| `stream.getSubagentsByType("x")`                  | `[...stream.subagents.values()].filter(s => s.name === "x")` |
| `stream.activeSubagents`                          | `[...stream.subagents.values()].filter(s => s.status === "running")` |
| `stream.getSubagentsByMessage(mid)`               | helper `subagentsForMessage(stream, mid)` (stdlib)        |
| `stream.submit` / `stream.stop`                   | unchanged                                                 |
| `stream.branch` / `setBranch` / `history`         | TODO (see §10)                                            |

Every breaking change is mechanical and codemod-able. The hook
still returns one object; it's strictly smaller than v1.

---

## 9. SDK foundations (shipped)

All three prerequisites below are implemented in
`libs/sdk/src/stream-experimental/` and exported from
`@langchain/langgraph-sdk/stream` — ready to be composed
by any framework binding.

1. **`assembledToBaseMessage` / `assembledMessageToBaseMessage`**
   (`assembled-to-message.ts`). Converts the protocol-native
   content-block shape into a `BaseMessage` class instance
   (`HumanMessage` / `AIMessage` / `AIMessageChunk` / `ToolMessage` /
   `SystemMessage`) based on the `message-start` role, flattening
   content blocks and aggregating tool-call chunks. Every public
   `messages` projection is wired through it — the "class instances
   only" rule is enforced structurally, not by documentation.

   **Streaming tool calls → `AIMessageChunk`.** Anthropic-style
   models emit tool invocations as `tool_call_chunk` content
   blocks that stream a partial JSON fragment per delta and get
   promoted to a finalized `tool_call` block on
   `content-block-finish`. The concrete `AIMessage` class silently
   drops the `tool_call_chunks` field, so while the block is still
   streaming we return an `AIMessageChunk` (which preserves it).
   This lets the UI render a provisional tool card — with partial
   args parsed via `tryParsePartialJson` — during the stream,
   instead of an empty assistant bubble that only "fills in" once
   the whole tool call lands. Once `content-block-finish`
   promotes the chunks to a finalized `tool_call`, the projection
   emits a plain `AIMessage` with `tool_calls` populated, which
   seamlessly replaces the chunk instance in the downstream
   `messages` array.

2. **Single shared root subscription** (`controller.ts`). The
   controller opens exactly one `thread.subscribe(["values",
   "lifecycle", "input", "messages", "tools"])` for the root
   namespace and feeds: the `rootStore` (values / messages / tool
   calls / interrupts), the `SubagentDiscovery` runner, and the
   `SubgraphDiscovery` runner. Zero duplicated subscriptions.

   **Multi-run pump lifecycle.** The SSE transport pauses the
   underlying subscription when a terminal root lifecycle event
   arrives (each run = one server stream), and `ThreadStream`
   calls `subscription.resume()` on every `run.input` /
   `input.respond` via `#prepareForNextRun`. A single
   `for await (const event of subscription)` loop would therefore
   exit after the first run and miss the second. The root pump is
   wrapped in a `while (!disposed)` that re-enters the inner
   iterator after each pause/resume cycle, so one
   `useStreamExperimental` instance survives an arbitrary number
   of `submit()` calls on the same thread with exactly one
   `/events` subscription.

   **Messages merge (stream channel wins over values snapshots).**
   The root pump folds `messages`-channel token deltas through
   `MessageAssembler` and writes each assembly update into
   `rootStore.messages` by `messageId`. When a `values` event
   lands with a `messages` array, the controller **merges** it
   with the stream-assembled projection rather than replacing it:
   for every id present in both, the stream-assembled instance
   wins (it carries the latest token-level deltas); new ids in
   values are appended verbatim. Stream-assembled messages that
   haven't yet been echoed into `values.messages` are preserved
   (appended after the values-ordered prefix) so the UI doesn't
   truncate an in-progress turn when an older superstep's values
   snapshot lands. Without this merge, the trailing `values` event
   at each superstep boundary would stomp on any in-progress
   assistant turn and the user would see the final message appear
   in a single render instead of streaming token-by-token.

   **Root message / tool-call scoping.** The protocol emits token
   deltas under the enclosing node's namespace — e.g. a StateGraph's
   orchestrator LLM streams on `["model:<uuid>"]` or
   `["model_request:<uuid>"]`. Those events belong to the root run
   (their ids round-trip through root `values.messages`) so the
   controller accepts them into `root.messages` / `root.toolCalls`.

   Two families of namespaces are excluded from root assembly:

   - `task:*` segment anywhere in the namespace — legacy subagent
     convention.
   - `tools:*` segment anywhere in the namespace — every tool
     execution is wrapped in a `tools` subgraph, and its internal
     content should not pollute the orchestrator's message feed:
     - for simple tools the only content is the eventual tool
       result, which `values.messages` already echoes into
       `root.messages` verbatim (as a `ToolMessage` with the
       authoritative `tool_call_id`);
     - for the deep-agent `task` tool the content IS the spawned
       subagent's full message + tool stream, surfaced separately
       via `useMessages(stream, subagent)` /
       `useToolCalls(stream, subagent)` (its `.namespace` is set to
       `["tools:<tool_call_id>"]`, which matches where the
       subagent's own events fire).

   `tools`-CHANNEL events (distinct from the `tools:*` namespace)
   are still assembled into `root.toolCalls`, but only for
   single-segment `["tools:<id>"]` namespaces — anything deeper is
   a subagent's own tool call and lives on its `useToolCalls`
   projection. Every other channel (`values`, `lifecycle`, `input`)
   is still read strictly at the root namespace.

  **Tool-message `tool_call_id` recovery.** The `messages` channel's
  `message-start` event for a `role: "tool"` response carries
  `message_id` and `role` but *not* `tool_call_id`. The correlation
  has to be recovered so the assembled `ToolMessage` lands in
  `root.messages` with the same `tool_call_id` that `values.messages`
  would serialise — without it, UI-level pairing between an AI
  message's `tool_calls[].id` and the tool result breaks (the
  result orphans into its own bubble and the tool-card status pill
  stays stuck on "pending").

  A namespace-keyed map alone is not sufficient: multiple tool
  invocations in the same superstep can execute under a single
  `tools:<uuid>` namespace (e.g. `createAgent` batching two
  parallel tool calls), so the map collides and every tool
  message gets the *last* `tool_call_id` that was started in
  that namespace. The controller therefore recovers the id from
  the tool-message id itself (LangGraph emits tool-role messages
  with ids of the form `run-<run_id>-tool-<tool_call_id>`), and
  falls back to a `namespace → tool_call_id` map populated from
  the `tools` channel's `tool-started` event only when the id
  doesn't match that format.

   The same subscription is also exposed as a read-only `RootEventBus`
   (`{ channels, subscribe(listener) }`, re-exported from the public
   barrel). Consumers that only need a subset of the root pump's
   channels at the root namespace attach to this bus instead of
   opening a second server request:

   - `channelProjection` / `useChannel` — automatically short-circuits
     when every requested channel is covered by the root pump.
   - `StreamController`'s per-submit `#awaitNextTerminal` — one-shot
     listener for the next `completed` / `failed` / `interrupted`
     lifecycle event on the root namespace. Registered **before**
     `thread.run.input` / `thread.input.respond` is dispatched so
     fast server responses can't beat us to the terminal event.

   Net effect for the common "submit a prompt → stream → terminal"
   flow: one `/events` request for the root pump, regardless of how
   many selector hooks or debug panels are mounted (as long as they
   stay within the root pump's channel set).

   One caveat remains at the SDK layer: `ThreadStream.run.input()`
   eagerly opens a `[lifecycle, input]` and a
   `[values, lifecycle, input]` subscription to back the legacy
   `thread.output` / `thread.interrupts` surface. Our controller
   doesn't consume those, but we can't currently skip them from
   outside the SDK. Tracked as a follow-up in §10.

3. **Ref-counted `ChannelRegistry`** (`channel-registry.ts`). One
   instance per `StreamController`. Keyed by `spec.key` (kind +
   channels + namespace). First `acquire(spec)` opens the server
   subscription; every subsequent acquire with the same key bumps a
   ref count and shares the same `StreamStore`. Last `release()`
   closes the subscription and drops the store. Thread rebinds
   (via `controller.hydrate(newThreadId)`) transparently re-open
   every live entry against the new thread while keeping the store
   identity stable.

---

## 9b. Testbed

The `examples/ui-react-protocol` playground now ships the new hook
side-by-side with the legacy `useStream`. The transport picker has
two additional modes — `experimental-sse` and
`experimental-websocket` — which route into a new `views-experimental/`
tree:

- `StateGraphExperimentalView`, `CreateAgentExperimentalView` — show
  the always-on root projection (`stream.messages`, `stream.values`,
  `stream.error`) as the primary rendering surface. `useChannel` is
  used via a small helper (`useEventTrace`) to fill the trace panel
  from raw protocol events.
- `DeepAgentExperimentalView` / `ParallelSubagentsExperimentalView` —
  demonstrate the lazy, per-subagent `useMessages` / `useToolCalls`
  selector hooks. A subagent card/modal only mounts its selector
  hooks when the user expands / opens that specific subagent; the
  ref-counted registry tears the subscription down again on close.
  Discovery metadata (`stream.subagents`) is always available on the
  root, without opening any subagent-scoped subscriptions.
- `HumanInTheLoopExperimentalView` — reads `stream.interrupt` from
  the root projection and resumes via `stream.submit(null, { command:
  { resume } })`.

The testbed typechecks cleanly against both the local
`@langchain/react` source (via `paths` alias) and the published
`@langchain/langgraph-sdk` build.

---

## 10. Still TODO after this redesign

- `branch` / `setBranch` / `history` / `experimental_branchTree`
  via `thread.state.listCheckpoints` + `thread.state.fork`.
- `getMessagesMetadata` (align v2 metadata shape with the v1
  return type).
- `joinStream` — maps to `client.threads.joinStream` once v2
  replay semantics are finalised server-side.
- `toolProgress` — now trivial via
  `useChannel(stream, "custom:progress", subagent)`, but we
  should decide whether to ship a typed `useToolProgress` on top.
- **SDK-internal duplicate subscriptions on `run.input`.**
  `ThreadStream.run.input()` eagerly opens a `[lifecycle, input]`
  subscription (via `#ensureLifecycleTracking`) and a
  `[values, lifecycle, input]` subscription (via the `values`
  getter) to back the legacy `thread.output` / `thread.interrupts`
  surface. Both are already covered by our root pump's
  `[values, lifecycle, input, messages, tools]` subscription. We
  should add an opt-out knob on `ThreadStream` (or a direct
  `#send("run.input", …)` escape hatch) so the experimental
  controller can skip them — down from ≥ 3 `/events` requests per
  submit to 1.

All of these are additive and can land in follow-up PRs without
disturbing the selector-hook surface.

---

## 11. Design decisions log

1. **Selector hooks over imperative `watch()`.**
   Lifecycle tied to React mount is the only contract that
   survives refactors in application code. Imperative watches
   leak.
2. **One `useMessages(stream, target?)` for root, subagents,
   subgraphs, arbitrary namespaces.**
   `target` is the namespace, sourced either from a discovery
   snapshot or passed raw. No `useSubagent*` variants.
3. **`BaseMessage` class instances only.**
   The plain `Message` interface from
   `libs/sdk/src/types.messages.ts` is never returned from a
   hook and is not part of the public return type. The SDK
   gains `assembledToBaseMessage()` to make this a hard
   invariant.
4. **Discovery eager, content lazy.**
   Subagent/subgraph metadata is free (rides on the root
   subscription). Each subagent's messages/toolCalls/extension
   streams cost one subscription per `(kind, namespace)` across
   all mounted consumers of that projection.
5. **Ref-counted registry keyed on `(channels, namespace)`.**
   Two components rendering the same projection share one
   server subscription. The last unmount closes it via the
   SDK's `SubscriptionHandle.unsubscribe()`.
6. **No SDK API changes required.**
   All the above works against today's `ThreadStream.subscribe`
   + assembler modules. The only new SDK export is
   `assembledToBaseMessage`.

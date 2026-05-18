# Migrating to `@langchain/vue` v1

This guide walks Vue application authors through the jump from the
pre-v1 `useStream` composable to the v2-native `useStream` that ships
with `@langchain/vue` **v1**.

Short version: **the `useStream` import name does not change, but the
return shape, option bag, and protocol semantics do.** Most chat apps
migrate in well under an hour by following the checklists below. Apps
that lean heavily on `branch` / `setBranch` / `fetchStateHistory` or on
custom transport implementations have more work to do and are covered
in dedicated sections.

If you are cross-referencing the React migration, every behavioural
change is identical — only the binding idioms differ (Composition API
refs instead of React hooks).

---

## Table of contents

1. [Why the breaking change?](#1-why-the-breaking-change)
2. [TL;DR migration checklist](#2-tldr-migration-checklist)
3. [Option-bag migration](#3-option-bag-migration)
4. [Return-shape migration](#4-return-shape-migration)
5. [`submit()` signature changes](#5-submit-signature-changes)
6. [Companion selector composables — the new mental model](#6-companion-selector-composables--the-new-mental-model)
7. [Subagents & subgraphs](#7-subagents--subgraphs)
8. [Headless tools (`tools` + `onTool`)](#8-headless-tools-tools--ontool)
9. [Custom transports with `AgentServerAdapter`](#9-custom-transports-with-agentserveradapter)
10. [`provideStream` / `useStreamContext`](#10-providestream--usestreamcontext)
11. [Suspense-like hydration](#11-suspense-like-hydration)
12. [Type helpers](#12-type-helpers)
13. [Known gaps & server-side prerequisites](#13-known-gaps--server-side-prerequisites)
14. [FAQ](#14-faq)

---

## 1. Why the breaking change?

The legacy `useStream` was built against the v1 streaming protocol and
accreted a large surface of opt-in callbacks (`onUpdateEvent`,
`onCustomEvent`, `onMetadataEvent`, `onCheckpointEvent`, `onTaskEvent`,
`onToolEvent`, `onStop`, …) plus derived state (`branch`,
`experimental_branchTree`, `getMessagesMetadata`, `joinStream`,
`switchThread`) that had to be recomputed on every render.

The v1 composable targets protocol v2. In practice that means:

- **Selector-based subscriptions.** Namespaced data (subagent messages,
  subgraph tool calls, media) is opened *only* when a component
  actually mounts a selector composable, and released on scope
  disposal. No more fan-out cost for views that aren't on screen.
- **Always-on root projections.** `values` / `messages` / `toolCalls` /
  `interrupts` are always available at the root with zero wire cost
  beyond the protocol stream itself.
- **First-class re-attach.** Remounting a composable on an in-flight
  thread attaches to the live subscription instead of replaying from
  scratch; `isLoading` behaves consistently across route changes and
  hot module reloads.
- **Discriminated option bag.** The LGP path and the custom-adapter
  path are now two arms of a discriminated union, so passing both
  `assistantId` and an adapter is a compile-time error.
- **Type inference from agent brands.** `typeof agent` flows through
  to `values`, `toolCalls[].args`, and subagent-state maps without any
  `<MyState, MyBag>` boilerplate.

The net effect is a smaller, faster, more predictable API that still
covers every scenario the legacy composable supported.

---

## 2. TL;DR migration checklist

For the typical app this is the whole migration. Deeper changes are
flagged in the later sections.

- [ ] **Upgrade** `@langchain/vue` to `^1.0.0` and `vue` to `^3.4`.
- [ ] **Imports stay the same** — `import { useStream } from "@langchain/vue"`
      now resolves to the v2-native composable.
- [ ] **Read reactive state via `.value`** (or directly in templates
      where Vue auto-unwraps). `messages`, `values`, `toolCalls`,
      `interrupts`, `isLoading`, `error`, `threadId` are all refs now.
- [ ] **Remove these option-bag fields** (they are gone; see §3):
      `onError`, `onFinish`, `onUpdateEvent`, `onCustomEvent`,
      `onMetadataEvent`, `onLangChainEvent`, `onDebugEvent`,
      `onCheckpointEvent`, `onTaskEvent`, `onToolEvent`, `onStop`,
      `fetchStateHistory`, `reconnectOnMount`, `throttle`, `thread`,
      `filterSubagentMessages`, `subagentToolNames`.
- [ ] **Replace legacy custom transports** with
      `transport: new HttpAgentServerAdapter(...)` (see §9).
- [ ] **Remove these return-shape fields** (they moved or were dropped;
      see §4): `branch`, `setBranch`, `history`,
      `experimental_branchTree`, `getMessagesMetadata`, `toolProgress`,
      `joinStream`, `switchThread`, `queue`, `activeSubagents`,
      `getSubagent`, `getSubagentsByType`, `getSubagentsByMessage`.
- [ ] **Replace `getMessagesMetadata(msg)?.firstSeenState?.parent_checkpoint`**
      with `useMessageMetadata(stream, () => msg.id).value?.parentCheckpointId`
      (see §6).
- [ ] **Replace `stream.queue`** with `useSubmissionQueue(stream)` (see
      §6).
- [ ] **Replace `stream.switchThread(id)`** with passing a reactive
      `threadId` option and updating it (see §4).
- [ ] **Inside subagent-aware UIs**, read per-subagent data with the
      new selector composables (`useMessages(stream, subagent)` etc.)
      rather than reading `subagent.messages` / `subagent.toolCalls`
      off the discovery snapshot (see §7).
- [ ] **Re-run `tsc`**. The option bag and return type are now
      discriminated and strongly typed; most remaining issues surface
      as type errors that map to one of the sections below.

---

## 3. Option-bag migration

### 3.1 Still supported — same meaning

These keep working without changes:

| Option                                                | Notes                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `assistantId`                                         | Required for the LGP path; optional (defaults to `"_"`) for custom adapters. Captured at setup. |
| `client`                                              | LGP branch only. Captured at setup.                                                         |
| `apiUrl`, `apiKey`                                    | LGP branch only. Accept reactive inputs (`string` / `Ref<string>` / getter). |
| `callerOptions`, `defaultHeaders`                     | LGP branch only. Passed to the auto-constructed `Client`.                                   |
| `threadId`, `onThreadId`                              | Accept reactive inputs. Pass `null` to detach; passing a new string reloads the thread.     |
| `initialValues`                                       | Unchanged.                                                                                  |
| `messagesKey`                                         | Unchanged — defaults to `"messages"`.                                                       |
| `onCreated`                                           | Still fires with `{ run_id, thread_id }`.                                                   |
| `tools`, `onTool`                                     | Unchanged semantics; see §8.                                                                |

### 3.2 New options

| Option             | Notes                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`        | Two meanings: `"sse"` / `"websocket"` selects the built-in wire transport (LGP branch, default `"sse"`); an `AgentServerAdapter` instance flips the composable into the custom-adapter branch. |
| `fetch`            | LGP branch only. Forwarded to the built-in SSE transport.                                                                                                                                |
| `webSocketFactory` | LGP branch only. Forwarded to the built-in WebSocket transport.                                                                                                                          |

### 3.3 Removed — with replacements

| Legacy option                                                                                                                              | v1 replacement                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onError`                                                                                                                                  | Read `stream.error.value` directly; `watch(() => stream.error.value, ...)` if you need a side effect.                                                                                                                                              |
| `onFinish`                                                                                                                                 | Derive from `isLoading` transitioning `true → false`, or observe the thread via `useValues(stream)`.                                                                                                                                                |
| `onUpdateEvent`, `onCustomEvent`, `onMetadataEvent`, `onLangChainEvent`, `onDebugEvent`, `onCheckpointEvent`, `onTaskEvent`, `onToolEvent` | Drop. The v2 protocol delivers these as structured store updates; read them via selector composables (`useChannel`, `useExtension`) when you genuinely need raw events.                                                                             |
| `onStop`                                                                                                                                   | Drop. `stop()` now abort-signals the in-flight run and `values` reverts to the server's authoritative state.                                                                                                                                       |
| `fetchStateHistory`                                                                                                                        | Drop. Fork/edit flows use `useMessageMetadata` + `submit({}, { forkFrom })` instead (§5).                                                                                                                                                           |
| `reconnectOnMount`                                                                                                                         | Drop. Re-attach is automatic: remounting the composable with the same `threadId` attaches to the in-flight run.                                                                                                                                   |
| `throttle`                                                                                                                                 | Drop. The composable batches state updates natively; call sites that need render throttling can memoize at the selector site.                                                                                                                       |
| `thread`                                                                                                                                   | Drop. External thread managers should drive the composable by controlling `threadId` and `initialValues`.                                                                                                                                           |
| `filterSubagentMessages`                                                                                                                   | Drop. Subagent messages are already absent from `stream.messages`; they live on per-subagent selector composables (§7).                                                                                                                             |
| `subagentToolNames`                                                                                                                        | Drop. Subagent classification is driven by protocol-v2 lifecycle events, not by a client-side tool-name list.                                                                                                                                       |

Migrate silent callback side effects into `watch()` / `watchEffect()`:

```ts
// Before
useStream({ onFinish: (state) => analytics.track("turn_finished", state) });

// After
const stream = useStream({ assistantId });
watch(
  () => stream.isLoading.value,
  (loading, prev) => {
    if (prev && !loading) analytics.track("turn_finished", stream.values.value);
  },
);
```

---

## 4. Return-shape migration

### 4.1 Still there — same meaning

All reactive fields are now `Readonly<ShallowRef<T>>` or
`ComputedRef<T>` — read via `.value` in `<script setup>`, directly in
`<template>`.

| Field                       | Notes                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `values`                    | Typed as the resolved `StateType`, non-nullable at the root (falls back to `initialValues ?? {}`).     |
| `messages`                  | `BaseMessage[]` class instances from `@langchain/core/messages`.                                       |
| `toolCalls`                 | `AssembledToolCall[]` — renamed shape, see §4.3.                                                       |
| `interrupts`, `interrupt`   | `interrupt` is the most recent root interrupt.                                                         |
| `isLoading`                 | True while a run is in flight *or* initial hydration hasn't completed.                                 |
| `error`                     | Unchanged.                                                                                             |
| `threadId`                  | Unchanged.                                                                                             |
| `client`                    | LGP `Client` when the built-in transport is in use. Plain value — captured at setup.                   |
| `assistantId`               | Resolved value including the `"_"` fallback used by custom adapters. Plain value.                      |
| `submit`, `stop`, `respond` | Same high-level semantics; `submit`'s argument types are wider, see §5.                                |

### 4.2 Still there — different meaning

| Field             | What changed                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents`       | `ShallowRef<ReadonlyMap<string, SubagentDiscoverySnapshot>>`. The snapshot only carries id / name / namespace / status — **no** `messages` / `toolCalls` / `values`. Read those via selectors (§7). |
| `isThreadLoading` | Reflects the initial thread-load lifecycle rather than `fetchStateHistory`.                                                                                                                        |

### 4.3 Removed — with replacements

| Legacy field                                                                    | v1 replacement                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch`, `setBranch`, `experimental_branchTree`                                | Branching is expressed as fork-from-checkpoint: call `useMessageMetadata(stream, () => msg.id)` to read the message's parent checkpoint and `submit(input, { forkFrom: { checkpointId } })` to fork. |
| `history`, `fetchStateHistory`                                                  | Dropped from the composable. Fetch history explicitly with `client.threads.getHistory(threadId)` if you need it; most apps do not.                                                             |
| `getMessagesMetadata(msg, i)`                                                   | `useMessageMetadata(stream, () => msg.id).value?.parentCheckpointId` (see §6).                                                                                                                |
| `toolProgress`                                                                  | Dropped. Tool progress is now observable via `useToolCalls(stream)` — each `AssembledToolCall` carries its own `status`.                                                                       |
| `joinStream(runId, ...)`                                                        | Dropped. Remounting the composable with the right `threadId` rejoins automatically.                                                                                                            |
| `switchThread(newThreadId)`                                                     | Drive `threadId` as a reactive option. The composable reloads on change.                                                                                                                       |
| `queue`                                                                         | `useSubmissionQueue(stream)` companion composable (see §6).                                                                                                                                    |
| `activeSubagents`, `getSubagent`, `getSubagentsByType`, `getSubagentsByMessage` | Iterate `stream.subagents.value` (a `Map`) and filter inline; every discovery snapshot carries `name`, `status`, `parentId`, `namespace`, and the tool-call id that spawned it.                |

### 4.4 New fields

| Field             | Purpose                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subgraphs`       | `ShallowRef<ReadonlyMap<string, SubgraphDiscoverySnapshot>>` — subgraphs discovered on the thread (distinct from subagents). |
| `subgraphsByNode` | Same data keyed by graph node. Arrays preserve parallel fan-out order.                                                       |
| `hydrationPromise` | `ComputedRef<Promise<void>>` that settles when initial thread hydration completes. See §11.                                  |

### 4.5 Worked example — minimal diff

```vue
<!-- Before -->
<script setup lang="ts">
import { useStream } from "@langchain/vue";

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
</script>
```

```vue
<!-- After -->
<script setup lang="ts">
import { watch } from "vue";
import { useStream, useMessageMetadata } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
const { messages, isLoading, error, submit } = stream;

watch(
  () => error.value,
  (e) => {
    if (e) console.error(e);
  },
);

// Branching → read parent checkpoint off the message you want to fork from
const metadata = useMessageMetadata(
  stream,
  () => messages.value.at(-1)?.id,
);
</script>
```

---

## 5. `submit()` signature changes

### 5.1 Input widening

`submit()` now accepts **either** a wire-format message payload **or**
an array of `BaseMessage` class instances:

```ts
await submit({ messages: [{ role: "user", content: "hi" }] });
await submit({ messages: [new HumanMessage("hi")] });
await submit({ messages: new HumanMessage("hi") });
```

### 5.2 Option changes

| Legacy `SubmitOptions` field                                                                                                                          | v1 `StreamSubmitOptions` equivalent                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `config.configurable`                                                                                                                                 | `config.configurable` (unchanged)                                                                |
| `context`                                                                                                                                             | Drop — fold into `config.configurable`.                                                           |
| `checkpoint: { checkpoint_id }`                                                                                                                       | `forkFrom: { checkpointId }` (new, cleaner shape).                                               |
| `command: { resume }`                                                                                                                                 | Same. Additionally `{ goto, update }` are type-accepted for forward compatibility.               |
| `interruptBefore`, `interruptAfter`                                                                                                                   | Drop — not supported in v2.                                                                       |
| `metadata`                                                                                                                                            | Unchanged.                                                                                       |
| `multitaskStrategy`                                                                                                                                   | Unchanged. `"rollback"` is honoured client-side today; `"reject"`, `"enqueue"`, `"interrupt"` compile but require the matching server release (see §13). |
| `onCompletion`, `onDisconnect`, `feedbackKeys`, `streamMode`, `runId`, `optimisticValues`, `streamSubgraphs`, `streamResumable`, `checkpointDuring`   | Drop. Most map to protocol-v2 defaults.                                                          |

```ts
// Before
await submit({ messages: [new HumanMessage("retry")] }, {
  checkpoint: { checkpoint_id: "cp_123" },
  multitaskStrategy: "rollback",
});

// After
await submit(
  { messages: [new HumanMessage("retry")] },
  { forkFrom: { checkpointId: "cp_123" }, multitaskStrategy: "rollback" },
);
```

---

## 6. Companion selector composables — the new mental model

Legacy `useStream` returned *everything* in one object. v1 keeps the
always-on data on the root return and pushes the rest into **companion
selector composables** that ref-count their server subscriptions. Mount
them where you render; on scope disposal cleanup is automatic.

All of these are exported from `@langchain/vue`:

| Composable                                        | Replaces                             | Notes                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useValues(stream)`                               | `stream.values`                      | Root form is a free read; scoped form (`useValues(stream, target)`) opens a namespaced subscription. Explicit generic: `useValues<State>(stream, sub)`. |
| `useMessages(stream)`                             | `stream.messages`                    | Same pattern. Scoped view yields subagent / subgraph messages without fan-out.                                                                          |
| `useToolCalls(stream)`                            | `stream.toolCalls`                   | Typed tool-call union is inferred from `typeof agent` or an explicit tools array.                                                                       |
| `useMessageMetadata(stream, messageId)`           | `stream.getMessagesMetadata(msg, i)` | `messageId` accepts a `string`, `Ref<string>`, or getter. Returns a `ComputedRef<{ parentCheckpointId } \| undefined>`.                                |
| `useSubmissionQueue(stream)`                      | `stream.queue`                       | Returns `{ entries, size, cancel(id), clear() }`. Backed by `multitaskStrategy: "enqueue"`.                                                             |
| `useExtension(stream, name)`                      | Per-event callbacks                  | Read a named protocol extension (custom channel).                                                                                                       |
| `useChannel(stream, channels)`                    | Raw event callbacks                  | Low-level escape hatch.                                                                                                                                 |
| `useAudio`, `useImages`, `useVideo`, `useFiles`   | —                                    | Multimodal streaming.                                                                                                                                   |
| `useMediaURL`, `useAudioPlayer`, `useVideoPlayer` | —                                    | Helpers built on top of the media composables.                                                                                                          |

### 6.1 Naming conflicts with your own composables

If your app already defines a `useMessages` (or similar), alias on
import:

```ts
import { useMessages as useAgentMessages } from "@langchain/vue";
```

### 6.2 Fork from message (the old `branch` flow)

```vue
<script setup lang="ts">
import { HumanMessage } from "@langchain/core/messages";
import { useMessageMetadata, type AnyStream } from "@langchain/vue";
import type { BaseMessage } from "@langchain/core/messages";

const props = defineProps<{ stream: AnyStream; message: BaseMessage }>();
const metadata = useMessageMetadata(props.stream, () => props.message.id);

async function edit() {
  const checkpointId = metadata.value?.parentCheckpointId;
  if (!checkpointId) return;
  await props.stream.submit(
    { messages: [new HumanMessage("...revised prompt...")] },
    { forkFrom: { checkpointId } },
  );
}
</script>

<template>
  <button :disabled="!metadata?.parentCheckpointId" @click="edit">
    Edit from here
  </button>
</template>
```

### 6.3 Enqueue-and-cancel (the old `queue` flow)

```vue
<script setup lang="ts">
import { HumanMessage } from "@langchain/core/messages";
import { useSubmissionQueue, type AnyStream } from "@langchain/vue";

const props = defineProps<{ stream: AnyStream }>();
const { entries, size, cancel, clear } = useSubmissionQueue(props.stream);
</script>

<template>
  <button
    @click="
      stream.submit(
        { messages: [new HumanMessage('go')] },
        { multitaskStrategy: 'enqueue' },
      )
    "
  >
    Queue turn
  </button>
  <ol>
    <li v-for="entry in entries" :key="entry.id">
      pending…
      <button @click="cancel(entry.id)">cancel</button>
    </li>
  </ol>
  <button v-if="size > 0" @click="clear">Clear queue</button>
</template>
```

---

## 7. Subagents & subgraphs

### 7.1 Discovery

Subagents and subgraphs are **discovered eagerly but streamed lazily**.
The discovery maps (`stream.subagents`, `stream.subgraphs`,
`stream.subgraphsByNode`) are kept in sync with zero extra wire cost;
each snapshot exposes identity fields only:

```ts
interface SubagentDiscoverySnapshot {
  readonly id: string;              // tool-call id that spawned it
  readonly name: string;            // "researcher", "writer", …
  readonly namespace: readonly string[];
  readonly parentId: string | null;
  readonly depth: number;
  readonly status: "pending" | "running" | "complete" | "error";
  // — no messages / toolCalls / values. Use selector composables below.
}
```

### 7.2 Per-subagent content

Replace every `subagent.messages` / `subagent.toolCalls` /
`subagent.values` read with the matching selector, passing the
discovery snapshot:

```vue
<!-- Parent -->
<template>
  <SubagentCard
    v-for="sub in [...stream.subagents.values()]"
    :key="sub.id"
    :stream="stream"
    :subagent="sub"
  />
</template>
```

```vue
<!-- SubagentCard.vue -->
<script setup lang="ts">
import {
  useMessages,
  useToolCalls,
  useValues,
  type AnyStream,
  type SubagentDiscoverySnapshot,
} from "@langchain/vue";

const props = defineProps<{
  stream: AnyStream;
  subagent: SubagentDiscoverySnapshot;
}>();

const messages = useMessages(props.stream, props.subagent);
const toolCalls = useToolCalls(props.stream, props.subagent);
const values = useValues<ResearcherState>(props.stream, props.subagent);
</script>
```

The first time any component mounts `useMessages(stream, subagent)` a
`messages`-channel subscription is opened, scoped to
`subagent.namespace`. On scope disposal (component unmount, HMR, etc.)
the subscription is released automatically. This is the single biggest
wire-cost win of the new design.

### 7.3 Removed helpers

`activeSubagents`, `getSubagent(id)`, `getSubagentsByType(name)`, and
`getSubagentsByMessage(msg)` are gone. Derive them inline against
`stream.subagents.value`:

```ts
const active = computed(() =>
  [...stream.subagents.value.values()].filter((s) => s.status === "running"),
);
```

---

## 8. Headless tools (`tools` + `onTool`)

The legacy `tools` / `onTool` options are preserved one-for-one. The
root composable listens for interrupt payloads that target a registered
tool, invokes the handler, and auto-resumes the run with the handler's
return value — exactly the pre-v1 behaviour.

```ts
const stream = useStream({
  assistantId: "deep-agent",
  tools: [getCurrentLocation, confirmAction],
  onTool: (event) => {
    if (event.type === "error") logger.error(event.error);
  },
});
```

No migration is needed if you were already using this API. Helper
exports (`flushPendingHeadlessToolInterrupts`, `findHeadlessTool`,
`handleHeadlessToolInterrupt`, …) remain available from
`@langchain/vue` for advanced flows.

---

## 9. Custom transports with `AgentServerAdapter`

The custom-transport surface now uses the framework-agnostic
`AgentServerAdapter` interface (same contract the React binding uses),
with `HttpAgentServerAdapter` covering the common HTTP/SSE case.

```ts
import { HttpAgentServerAdapter, useStream } from "@langchain/vue";

const adapter = new HttpAgentServerAdapter({
  apiUrl: "/api/agent",
  headers: () => ({ Authorization: `Bearer ${token.value}` }),
});

const stream = useStream({
  transport: adapter,
  assistantId: "agent",
});
```

When `transport` is an `AgentServerAdapter` instance, the LGP-specific
options (`client`, `apiUrl`, `apiKey`, `fetch`, `webSocketFactory`) are
not accepted — the option bag is a discriminated union. See
[`transports.md`](./transports.md) for the adapter contract and a full
custom transport example.

---

## 10. `provideStream` / `useStreamContext`

The legacy `StreamProvider` / `useStreamContext` pair is replaced by
`provideStream(options)` (to be called in an ancestor's
`<script setup>`) and `useStreamContext()` (to read the shared handle
in a descendant).

```vue
<!-- Parent.vue -->
<script setup lang="ts">
import { provideStream } from "@langchain/vue";
provideStream({ assistantId: "agent", apiUrl: "http://localhost:2024" });
</script>
```

```vue
<!-- Child.vue -->
<script setup lang="ts">
import { useStreamContext } from "@langchain/vue";
import type { agent } from "./agent";

const { messages, submit } = useStreamContext<typeof agent>();
</script>
```

For app-wide defaults (e.g. `apiUrl`), install the plugin once on
`createApp`:

```ts
import { createApp } from "vue";
import { LangChainPlugin } from "@langchain/vue";

createApp(App).use(LangChainPlugin, { apiUrl: "/api" });
```

---

## 11. Suspense-like hydration

React v1 ships a dedicated `useSuspenseStream`. Vue does not ship one
— Vue's built-in `<Suspense>` is triggered by any `async setup()`, so
you can implement the same pattern in two lines:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  threadId: "thread_123",
});
await stream.hydrationPromise.value;
</script>
```

Wrap the component in `<Suspense>` from an ancestor to show a
fallback until hydration completes.

---

## 12. Type helpers

| Legacy             | v1                                             |
| ------------------ | ---------------------------------------------- |
| `UseStream<T>`     | `UseStreamReturn<T>`                           |
| `StateOf<T>`       | `InferStateType<T>` (alias kept for parity)    |
| —                  | `AnyStream` — erased handle for prop-drilling. |

```ts
import type { UseStreamReturn, AnyStream } from "@langchain/vue";

function renderMessages(stream: AnyStream) {
  // work without carrying <T, I, C> through every prop signature
}
```

---

## 13. Known gaps & server-side prerequisites

- `multitaskStrategy: "reject" | "enqueue" | "interrupt"` compile
  today but require the matching server release. Only `"rollback"` is
  fully honoured on older servers.
- `forkFrom` + `submit()` requires a server release that supports
  protocol v2 checkpoints.

---

## 14. FAQ

**Q: Can I use the v1 binding with a LangGraph server that still
speaks protocol v1?**
No. v1 is strictly v2-native. Stay on `@langchain/vue@0.x` until your
server is upgraded.

**Q: Why does `stream.values` show stale data during a run?**
It doesn't — `values` reflects the server's authoritative state
stream. If you were relying on `optimisticValues` to tag pending UI,
wrap a `computed` that overlays your optimistic bit on top of
`stream.values.value`.

**Q: Do I need to manually clean up anything on unmount?**
No. Every reactive source the composables open is tied to the calling
scope via `onScopeDispose`. Scope disposal is automatic on component
unmount, HMR, and manual `effectScope().stop()`.

**Q: Why is `client` / `assistantId` captured at setup and not
reactive?**
Rebinding a client or assistant mid-session would require tearing down
every in-flight subscription, queue entry, and hydration promise.
Instead, remount the component (e.g. wrap it with a `:key="client.id"`
binding) to get a fresh controller.

# Migrating to `@langchain/angular` v1

This guide walks application authors through the jump from the pre-v1
`injectStream` / `useStream` API to the v2-native `injectStream` that
ships with `@langchain/angular@^1.0.0`.

Short version: **the `injectStream` import name does not change, but
the return shape, option bag, and protocol semantics do.** Most chat
apps migrate in well under an hour by following the checklists below.
Apps that lean heavily on `history`, `branch`, `fetchStateHistory`, or
on a custom `UseStreamTransport` have more work to do — those are
covered in their own sections.

---

## Table of contents

1. [Why the breaking change?](#1-why-the-breaking-change)
2. [TL;DR migration checklist](#2-tldr-migration-checklist)
3. [Option-bag migration](#3-option-bag-migration)
4. [Return-shape migration](#4-return-shape-migration)
5. [`submit()` signature changes](#5-submit-signature-changes)
6. [Companion selector injectors — the new mental model](#6-companion-selector-injectors--the-new-mental-model)
7. [Subagents & subgraphs](#7-subagents--subgraphs)
8. [Headless tools (`tools` + `onTool`)](#8-headless-tools)
9. [Custom transports: `UseStreamTransport` → `AgentServerAdapter`](#9-custom-transports)
10. [`provideStream` / zero-argument `injectStream()`](#10-providestream--zero-argument-injectstream)
11. [`StreamService` redesign](#11-streamservice-redesign)
12. [Type helpers](#12-type-helpers)
13. [Known gaps](#13-known-gaps)

---

## 1. Why the breaking change?

The legacy `injectStream` was built against the v1 streaming protocol
and accreted a large surface of opt-in callbacks (`onUpdateEvent`,
`onCustomEvent`, `onMetadataEvent`, `onStop`, …) plus derived state
(`history`, `branch`, `experimental_branchTree`,
`getMessagesMetadata`, `joinStream`) that had to be recomputed on every
change-detection cycle.

The v1 injector targets **protocol v2**. In practice that means:

- **Selector-based subscriptions.** Namespaced data (subagent
  messages, subgraph tool calls, media) is opened *only* when a
  component actually uses a selector injector, and released on
  `DestroyRef`. Nothing fans out to views that aren't on screen.
- **Always-on root projections.** `values` / `messages` / `toolCalls`
  / `interrupts` are always available at the root with zero wire cost
  beyond the protocol stream itself.
- **First-class re-attach.** Reconstructing the injector against an
  in-flight thread attaches to the live subscription instead of
  replaying from scratch; `isLoading` behaves consistently across
  route navigations.
- **Discriminated option bag.** The LangGraph Platform path and the
  custom-adapter path are two arms of a discriminated union; passing
  both `assistantId` and a non-string `transport` is a compile-time
  error.
- **Signals end-to-end.** Every reactive field on the return handle is
  an Angular `Signal` that composes with `computed` / `effect` and
  plays nicely with zoneless / OnPush components.

The net effect is a smaller, faster, more predictable API.

---

## 2. TL;DR migration checklist

For the typical chat app, this is the whole migration. Deeper changes
are flagged in the later sections.

- [ ] **Upgrade** `@langchain/angular` to `^1.0.0`.
- [ ] **Imports stay the same** — `import { injectStream } from "@langchain/angular"`
      now resolves to the v2-native injector. A framework-agnostic
      `useStream` factory is also exported for library code / advanced
      callers (see §11); prefer `injectStream` in component code.
- [ ] **Remove these option-bag fields** (see §3):
      `onError`, `onFinish`, `onUpdateEvent`, `onCustomEvent`,
      `onMetadataEvent`, `onStop`, `fetchStateHistory`,
      `reconnectOnMount`, `throttle`.
- [ ] **Remove these return-shape fields** (see §4):
      `branch`, `setBranch`, `history`, `getMessagesMetadata`,
      `joinStream`, `switchThread`, `queue`, `activeSubagents`,
      `getSubagent`, `getSubagentsByType`, `getSubagentsByMessage`.
- [ ] **Replace `stream.getMessagesMetadata(msg)`** with
      `injectMessageMetadata(stream, msg.id)` (see §6).
- [ ] **Replace `stream.queue`** with `injectSubmissionQueue(stream)`
      (see §6).
- [ ] **Replace `stream.switchThread(id)`** with passing
      `threadId: Signal<string | null>` and letting the injector
      reload on change (see §4).
- [ ] **Inside subagent-aware UIs**, read per-subagent data with the
      selector injectors (`injectMessages(stream, subagent)` etc.)
      rather than reading `subagent.messages` off the discovery
      snapshot.
- [ ] **Swap `FetchStreamTransport`** for
      `HttpAgentServerAdapter` from `@langchain/langgraph-sdk`
      (see §9).
- [ ] **Re-run `tsc`**. The option bag and return type are now
      discriminated and strongly typed; most remaining issues will
      surface as type errors that map to one of the sections below.
- [ ] **Rename stream-handle type annotations** to `StreamApi<T>` in
      Angular code. Keep `UseStreamResult<T>` only for utilities shared
      with React-style packages (see §12).

---

## 3. Option-bag migration

### 3.1 Still supported — same meaning

| Option | Notes |
|---|---|
| `assistantId` | Required for the LangGraph Platform branch; optional for custom adapters. |
| `apiUrl`, `apiKey`, `client`, `callerOptions`, `defaultHeaders` | LGP branch only. |
| `threadId`, `onThreadId` | Unchanged. Pass `null` to detach; passing a new string reloads the thread. `threadId` now also accepts `Signal<string \| null>`. |
| `initialValues` | Unchanged. |
| `messagesKey` | Unchanged — defaults to `"messages"`. |
| `onCreated` | Still fires with `{ run_id, thread_id }`. |
| `tools`, `onTool` | Unchanged semantics — see §8. |

### 3.2 New options

| Option | Notes |
|---|---|
| `transport` | `"sse"` / `"websocket"` selects the wire transport for the LGP branch; passing an `AgentServerAdapter` flips into the custom-adapter branch. |
| `fetch` | LGP branch only. Forwarded to the built-in SSE transport. |
| `webSocketFactory` | LGP branch only. Forwarded to the built-in WebSocket transport. |

### 3.3 Removed — with replacements

| Legacy option | v1 replacement |
|---|---|
| `onError` | Read `stream.error()` directly, or drive a `computed` / `effect` off it. |
| `onFinish` | Derive from `stream.isLoading()` transitioning `true → false`. |
| `onUpdateEvent`, `onCustomEvent`, `onMetadataEvent` | Drop. Use `injectChannel` / `injectExtension` for raw events. |
| `onStop` | Drop. `stop()` aborts the in-flight run; observe `isLoading()` for UI effects. |
| `fetchStateHistory` | Drop. Fork flows use `injectMessageMetadata` + `submit({}, { forkFrom })` (see §5 / §6). |
| `reconnectOnMount` | Drop. Re-attach is automatic. |
| `throttle` | Drop. The injector batches state updates natively. |

Any callback-based side effect should migrate into `effect()`:

```typescript
// Before
injectStream({
  assistantId: "agent",
  onFinish: (state) => analytics.track("turn_finished", state),
});

// After
const stream = injectStream({ assistantId: "agent" });
effect(() => {
  if (!stream.isLoading()) analytics.track("turn_finished", stream.values());
});
```

---

## 4. Return-shape migration

### 4.1 Still there — same meaning, now as signals

| Field | Notes |
|---|---|
| `values()` | Typed as the resolved `StateType`, non-nullable at the root (falls back to `initialValues ?? {}`). |
| `messages()` | `Signal<BaseMessage[]>`. |
| `toolCalls()` | `Signal<AssembledToolCall[]>`. |
| `interrupts()` / `interrupt()` | Pending root interrupts. |
| `isLoading()` / `isThreadLoading()` | `isLoading` is `true` while a run is in flight or hydration hasn't completed; `isThreadLoading` tracks only initial hydration. |
| `error()` | Unchanged. |
| `threadId()` | `Signal<string \| null>`. |
| `submit()`, `stop()` | Same high-level semantics; `submit`'s argument types are wider (§5). A new `respond(response, target)` is available for targeted interrupt replies. |
| `client` | Resolved `Client` when the LGP branch is in use. |

### 4.2 Still there — different shape

| Field | What changed |
|---|---|
| `subagents()` | `Signal<ReadonlyMap<id, SubagentDiscoverySnapshot>>`. The snapshot only carries id / name / namespace / status — **no** `messages` / `toolCalls` / `values`. Read those via selector injectors (§7). |

### 4.3 Removed — with replacements

| Legacy field | v1 replacement |
|---|---|
| `branch`, `setBranch`, `experimental_branchTree` | Fork from a checkpoint: `injectMessageMetadata(stream, msg.id)` → `submit(input, { forkFrom: { checkpointId } })`. |
| `history`, `fetchStateHistory` | Dropped. Fetch explicitly with `client.threads.getHistory(threadId)` if required. |
| `getMessagesMetadata(msg, i)` | `injectMessageMetadata(stream, msg.id)` returns `Signal<{ parentCheckpointId } \| undefined>` (§6). |
| `toolProgress` | Dropped. Each `AssembledToolCall` carries its own `status`. |
| `joinStream(runId, …)` | Dropped. Reconstructing the injector with the right `threadId` rejoins automatically. |
| `switchThread(newThreadId)` | Drive `threadId` as a `Signal`. The injector reloads on change. |
| `queue` | `injectSubmissionQueue(stream)` companion injector (§6). |
| `activeSubagents`, `getSubagent`, `getSubagentsByType`, `getSubagentsByMessage` | Iterate `stream.subagents()` (a `Map`) and filter inline; mount `injectMessages(stream, snapshot)` to read content. |

### 4.4 New fields

| Field | Purpose |
|---|---|
| `subgraphs()` | `Signal<ReadonlyMap<string, SubgraphDiscoverySnapshot>>` — subgraphs discovered on the thread. |
| `subgraphsByNode()` | Same data keyed by graph node. |
| `hydrationPromise()` | Resolves once initial thread load finishes. Useful for SSR / `await`-before-render pipelines. |
| `respond(response, target)` | Reply to a specific interrupt id. |

### 4.5 Worked example — minimal diff

```typescript
// Before
@Component({ /* … */ })
export class Chat {
  readonly stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    onError: (err) => console.error(err),
    fetchStateHistory: true,
  });

  branch(msg: BaseMessage) {
    const meta = this.stream.getMessagesMetadata(msg);
    // …
  }
}

// After
@Component({ /* … */ })
export class Chat {
  readonly stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  constructor() {
    effect(() => {
      const err = this.stream.error();
      if (err) console.error(err);
    });
  }
}
```

---

## 5. `submit()` signature changes

### 5.1 Input widening

`submit()` accepts **either** a wire-format message payload **or** a
`BaseMessage` class instance / array of instances:

```typescript
await this.stream.submit({ messages: [{ role: "user", content: "hi" }] });
await this.stream.submit({ messages: [new HumanMessage("hi")] });
await this.stream.submit({ messages: new HumanMessage("hi") });
```

### 5.2 Option changes

| Legacy `SubmitOptions` field | v1 `StreamSubmitOptions` equivalent |
|---|---|
| `config.configurable` | `config.configurable` (unchanged) |
| `context` | Fold into `config.configurable`. |
| `checkpoint: { checkpoint_id }` | `forkFrom: { checkpointId }`. |
| `command: { resume }` | Same. `{ goto, update }` also accepted for forward compatibility. |
| `interruptBefore`, `interruptAfter` | Drop — not supported in v2. |
| `metadata` | Unchanged. |
| `multitaskStrategy` | Unchanged. |
| `onCompletion`, `onDisconnect`, `feedbackKeys`, `streamMode`, `runId`, `optimisticValues`, `streamSubgraphs`, `streamResumable`, `checkpointDuring` | Drop. These map to protocol-v2 defaults. |

---

## 6. Companion selector injectors — the new mental model

The legacy `injectStream` returned *everything* in one object. v1 keeps
the always-on data on the root handle and pushes the rest into
**companion selector injectors** that ref-count their subscriptions.
Call them from an injection context (component field, constructor, or
`runInInjectionContext`); the `DestroyRef` handles cleanup.

All of these are exported from `@langchain/angular`:

| Injector | Replaces | Notes |
|---|---|---|
| `injectMessages(stream, target?)` | `stream.messages` (namespaced) | Root form returns `stream.messages` directly; the scoped form opens a namespaced subscription. |
| `injectToolCalls(stream, target?)` | `stream.toolCalls` (namespaced) | Typed tool-call union is inferred from `typeof agent` or an explicit `tools` array. |
| `injectValues(stream, target?)` | `stream.values` (namespaced) | Same pattern. |
| `injectMessageMetadata(stream, msgId)` | `stream.getMessagesMetadata(msg, i)` | Returns `Signal<{ parentCheckpointId } \| undefined>`. Drives fork-from-checkpoint. |
| `injectSubmissionQueue(stream)` | `stream.queue` | Returns `{ entries, size, cancel(id), clear() }`. |
| `injectExtension(stream, name, …)` | Per-event callbacks | Read a named protocol extension. |
| `injectChannel(stream, channels, …)` | Raw event callbacks | Low-level escape hatch. |
| `injectAudio`, `injectImages`, `injectVideo`, `injectFiles` | — | Multimodal streaming. |
| `injectMediaUrl(media)` | — | Creates and revokes an object URL for a media item. |

### 6.1 Fork from message (the old `branch` flow)

```typescript
@Component({
  standalone: true,
  template: `
    <button
      [disabled]="!metadata()?.parentCheckpointId"
      (click)="editFromHere()"
    >
      Edit from here
    </button>
  `,
})
export class EditButton {
  @Input({ required: true }) message!: BaseMessage;

  readonly stream = injectStream();
  readonly metadata = injectMessageMetadata(
    this.stream,
    () => this.message.id,
  );

  editFromHere() {
    const checkpointId = this.metadata()?.parentCheckpointId;
    if (!checkpointId) return;
    void this.stream.submit(
      { messages: [new HumanMessage("…revised prompt…")] },
      { forkFrom: { checkpointId } },
    );
  }
}
```

### 6.2 Enqueue-and-cancel (the old `queue` flow)

```typescript
@Component({
  standalone: true,
  template: `
    <button (click)="queueTurn()">Queue turn</button>
    @for (entry of queue.entries(); track entry.id) {
      <li>pending…
        <button (click)="queue.cancel(entry.id)">cancel</button>
      </li>
    }
    @if (queue.size() > 0) {
      <button (click)="queue.clear()">Clear queue</button>
    }
  `,
})
export class Composer {
  readonly stream = injectStream();
  readonly queue = injectSubmissionQueue(this.stream);

  queueTurn() {
    void this.stream.submit(
      { messages: [new HumanMessage("go")] },
      { multitaskStrategy: "enqueue" },
    );
  }
}
```

---

## 7. Subagents & subgraphs

### 7.1 Discovery

Subagents and subgraphs are now **discovered eagerly but streamed
lazily**. `stream.subagents()` / `stream.subgraphs()` /
`stream.subgraphsByNode()` are kept in sync with zero extra wire cost;
each snapshot exposes identity fields only:

```ts
interface SubagentDiscoverySnapshot {
  readonly id: string;
  readonly name: string;
  readonly namespace: readonly string[];
  readonly parentId: string | null;
  readonly depth: number;
  readonly status: "pending" | "running" | "complete" | "error";
}
```

### 7.2 Per-subagent content

Replace every `subagent.messages` / `subagent.toolCalls` /
`subagent.values` read with a selector injector:

```typescript
@Component({
  standalone: true,
  selector: "app-subagent-card",
  template: `
    @for (m of messages(); track m.id ?? $index) {
      <div>{{ asText(m.content) }}</div>
    }
  `,
})
export class SubagentCard {
  @Input({ required: true }) subagent!: SubagentDiscoverySnapshot;

  readonly stream = injectStream();
  readonly messages = injectMessages(this.stream, () => this.subagent);
  readonly toolCalls = injectToolCalls(this.stream, () => this.subagent);

  asText(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }
}
```

The first time any component calls `injectMessages(stream, subagent)`,
a scoped subscription is opened. When the last consumer is destroyed,
the subscription is released automatically.

---

## 8. Headless tools

The legacy `tools` / `onTool` options are preserved one-for-one. The
root injector listens for interrupt payloads that target a registered
tool, invokes the handler, and auto-resumes the run with the handler's
return value — exactly the pre-v1 behaviour.

```typescript
readonly stream = injectStream({
  assistantId: "deep-agent",
  tools: [getCurrentLocation, confirmAction],
  onTool: (event) => {
    if (event.type === "error") console.error(event.error);
  },
});
```

---

## 9. Custom transports

Legacy:

```typescript
import { FetchStreamTransport } from "@langchain/angular";

injectStream({
  transport: new FetchStreamTransport({ url: "…" }),
});
```

v1:

```typescript
import { HttpAgentServerAdapter } from "@langchain/langgraph-sdk";

injectStream({
  transport: new HttpAgentServerAdapter({ apiUrl: "…" }),
});
```

The new `AgentServerAdapter` interface is richer: it models thread
lifecycle, run creation, and re-attach in a single object.
`HttpAgentServerAdapter` is the stock HTTP/SSE (+ optional
WebSocket) implementation; most projects should start by sub-classing
it when they need header injection, auth, or observability hooks.

---

## 10. `provideStream` / zero-argument `injectStream()`

The contract stays the same — both `provideStream(options)` and
zero-argument `injectStream()` are v1 API. Internally they wire into
the same unified `injectStream` factory:

```typescript
// Before & After — unchanged
@Component({
  providers: [provideStream({ assistantId: "agent", apiUrl: "…" })],
})
export class ChatPage {}

// Elsewhere:
readonly stream = injectStream();
```

Zero-argument `injectStream()` throws if no ancestor has called
`provideStream(...)`. Pair it with `provideStreamDefaults(...)` in
`appConfig` to avoid repeating `apiUrl` / `apiKey` in every provider.

One caveat: the context now returns the **v1 `StreamApi`**, so any
consumer that previously read `stream.queue.size` / `stream.branch`
needs to swap to the selector injectors above.

---

## 11. `StreamService` redesign

Legacy `StreamService` wrapped a hidden orchestrator and exposed
mixed reactive + plain fields. v1 redesigns it as a thin class that
composes a framework-agnostic `useStream` factory:

```typescript
@Injectable({ providedIn: "root" })
export class ChatService extends StreamService<ChatState> {
  constructor() {
    super({ assistantId: "agent", apiUrl: "…" });
  }
}
```

The service forwards every `StreamApi` getter (`messages`, `values`,
`isLoading`, `submit`, `stop`, …) so existing component code that
calls `inject(ChatService)` and reads `chat.messages()` / calls
`chat.submit(…)` continues to work unchanged. The raw handle is also
available as `chat.stream` for code that needs to pass it into
selector injectors.

`useStream(options, destroyRef?)` is also exported for library code
that needs to own the controller outside Angular's injection context.
It returns the same `StreamApi` shape as `injectStream`.

---

## 12. Type helpers

| Legacy | v1 |
|---|---|
| `UseStream<T>` | `StreamApi<T>` for Angular code. |
| `UseStreamOptions<T>` | `UseStreamOptions<T>` — now a discriminated union of the LGP and custom-adapter branches. |
| `UseStreamTransport` | `AgentServerAdapter` (re-exported from `@langchain/langgraph-sdk`). |
| `CustomStreamTransport` | Dropped. |
| `StreamOrchestrator` | Dropped. |

`StreamApi<T>` and `UseStreamResult<T>` are aliases for the same stream
handle. Prefer `StreamApi<T>` when writing Angular components,
services, docs, and examples because it matches the Angular naming in
`injectStream`, `provideStream`, and `StreamService`. Use
`UseStreamResult<T>` only in shared utilities that intentionally accept
stream handles from React-style APIs as well.

```typescript
import type {
  StreamApi,
  UseStreamOptions,
  UseStreamResult,
} from "@langchain/angular";
import { useStream } from "@langchain/angular";

function wireChat(opts: UseStreamOptions<ChatState>): StreamApi<ChatState> {
  return useStream(opts);
}

function readSharedMessages(stream: UseStreamResult<ChatState>) {
  return stream.messages();
}
```

---

## 13. Known gaps

- `multitaskStrategy: "reject"` / `"enqueue"` / `"interrupt"` compile
  but require the matching server release to be fully honoured.
- `fetchStateHistory`-style history lists are no longer surfaced on
  the injector. If you had custom history UI, call
  `client.threads.getHistory(threadId)` directly; most apps can delete
  this code entirely.
- Subagent persistence across tab navigations requires the server to
  preserve subagent snapshots on `GET /threads/:id`. Clients that run
  against a fork of LangGraph Platform should check the server minimum
  version before upgrading.

# `injectStream`

`injectStream` is the root entry point of `@langchain/angular`. It
returns a Signals-first controller that streams graph state, messages,
tool calls, and interrupts into your component.

```typescript
import { Component } from "@angular/core";
import { injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div>{{ str(msg.content) }}</div>
    }

    <button
      [disabled]="stream.isLoading()"
      (click)="onSubmit()"
    >
      Send
    </button>
  `,
})
export class ChatComponent {
  readonly stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

`injectStream` must be called from an **Angular injection context**
(component / directive / service field initializer, or inside
`runInInjectionContext`). The host's `DestroyRef` owns the stream —
navigating away destroys the controller automatically.

## Options

The option bag is a discriminated union keyed by `assistantId` vs. a
custom `transport` adapter. Passing both `assistantId` and an adapter
is a compile-time error.

| Option | Type | Description |
|---|---|---|
| `assistantId` | `string` | **Required** for the LangGraph Platform branch. The assistant / graph ID the controller streams from. |
| `apiUrl` | `string` | Base URL of the LangGraph API. LGP branch only. |
| `apiKey` | `string` | API key forwarded to the built-in `Client`. |
| `client` | `Client` | Pre-configured `@langchain/langgraph-sdk` client. |
| `callerOptions` / `defaultHeaders` | `ClientConfig` fields | Forwarded to the built-in `Client`. |
| `transport` | `"sse" \| "websocket" \| AgentServerAdapter` | Wire transport. Omit for SSE. Passing an adapter flips into the custom-backend branch. |
| `fetch` | `typeof fetch` | Optional `fetch` override for the built-in SSE transport. |
| `webSocketFactory` | `(url: string) => WebSocket` | Optional `WebSocket` factory for the built-in WS transport. |
| `threadId` | `string \| null \| Signal<string \| null>` | Thread to bind to. Accepts a plain value, `null` (start a new thread on first submit), or a reactive `Signal` — updating the signal re-hydrates against the new thread in place. |
| `onThreadId` | `(id: string) => void` | Fires when a new thread is created server-side. |
| `onCreated` | `({ run_id, thread_id }) => void` | Fires as soon as the server acknowledges a run. |
| `initialValues` | `StateType` | Seed state used until the first payload arrives. |
| `messagesKey` | `string` | State key that carries the message array. Defaults to `"messages"`. |
| `tools` | `AnyHeadlessToolImplementation[]` | Headless tool implementations. Interrupts that target a registered tool are auto-resumed. |
| `onTool` | `OnToolCallback` | Observe lifecycle events for registered `tools`. |

Options **removed** in v1 (`onError`, `onFinish`, `onUpdateEvent`,
`onCustomEvent`, `onMetadataEvent`, `onStop`, `fetchStateHistory`,
`reconnectOnMount`, `throttle`) all have signal-based replacements —
see [`v1-migration.md`](./v1-migration.md) §3.

## Return shape

The root handle returned by `injectStream` is the public
`StreamApi<T>` type: a plain object of `Signal`s plus imperative
methods. Reactive fields are always Angular `Signal<T>`s — call them
as functions in templates (`stream.messages()`).

`UseStreamResult<T>` is an alias for the same shape, kept so
cross-framework helpers can use the same type name as the React SDK.
In Angular app and library code, prefer `StreamApi<T>`.

| Property | Type | Notes |
|---|---|---|
| `values` | `Signal<StateType>` | Current graph state. Non-nullable at the root (falls back to `initialValues ?? {}`). |
| `messages` | `Signal<BaseMessage[]>` | Messages assembled from the message channel. |
| `toolCalls` | `Signal<AssembledToolCall[]>` | Tool calls assembled with live status + args + results. |
| `interrupts` | `Signal<Interrupt[]>` | All pending root interrupts. |
| `interrupt` | `Signal<Interrupt \| undefined>` | Convenience: `interrupts()[0]`. |
| `isLoading` | `Signal<boolean>` | `true` while a run is in flight or hydration hasn't finished. |
| `isThreadLoading` | `Signal<boolean>` | `true` only during initial thread hydration. |
| `error` | `Signal<unknown>` | Last error surfaced by the controller. |
| `threadId` | `Signal<string \| null>` | Currently-bound thread. |
| `hydrationPromise` | `Signal<Promise<void>>` | Resolves once initial hydration finishes. Useful for SSR / `await`-before-render pipelines. |
| `subagents` | `Signal<ReadonlyMap<id, SubagentDiscoverySnapshot>>` | Lightweight discovery map — no messages / values. Read those via selectors. |
| `subgraphs` / `subgraphsByNode` | `Signal<ReadonlyMap<…>>` | Subgraph discovery, keyed by id or by node. |
| `submit(input, options?)` | `(…) => Promise<void>` | Start / resume / fork a run. |
| `stop()` | `() => Promise<void>` | Abort the in-flight run. |
| `respond(response, target?)` | `(…) => Promise<void>` | Reply to a specific interrupt by id. |
| `client` | `Client` | Built-in `Client` when using the LGP branch. |
| `assistantId` | `string` | Resolved assistant id (defaults to `"_"` when using a custom adapter). |

## Lifecycle

- Constructed once per host — the `DestroyRef` of the injection
  context owns the underlying controller.
- Discovery maps (`subagents`, `subgraphs`) stay lightweight: they
  carry id / name / namespace / status only. Read scoped content via
  [selectors](./selectors.md).
- Swap threads by updating the `threadId` signal; the controller
  re-hydrates in place and cancels any queued runs.

## Related

- [Transports](./transports.md) — SSE / WebSocket / custom adapters
- [Selectors](./selectors.md) — reading scoped data
- [Dependency injection](./dependency-injection.md) — sharing a stream
  across components
- [Type safety](./type-safety.md) — generics and agent inference

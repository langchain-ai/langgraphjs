# Selectors

The root handle exposes the always-on projections (`values`,
`messages`, `isLoading`, `error`, …). Everything that needs to be
**scoped** to a subagent, subgraph, or namespace lives behind a
selector injector. Selectors are ref-counted: the first caller opens a
subscription, and the last consumer's `DestroyRef` closes it.

| Selector | Purpose |
|---|---|
| `injectMessages(stream, target?)` | Messages for the target namespace. |
| `injectToolCalls(stream, target?)` | Assembled tool calls for the target. |
| `injectValues(stream, target?)` | State snapshot for the target. |
| `injectMessageMetadata(stream, msgId)` | `{ parentCheckpointId }` for forking / editing. |
| `injectSubmissionQueue(stream)` | `{ entries, size, cancel(id), clear() }` for the enqueue strategy. |
| `injectExtension(stream, name, target?)` | Latest payload of a `custom:<name>` extension. |
| `injectChannel(stream, channels, target?)` | Raw event stream (bounded buffer, all runs) — escape hatch. |
| `injectChannelEffect(stream, channels, options)` | Per-event side-effect callback (analytics, logging) — no re-render. |
| `injectAudio` / `injectImages` / `injectVideo` / `injectFiles` | Multimodal media streams. |
| `injectMediaUrl(media)` | Create + revoke an `objectURL` for a media handle. |

## Targets

`target` accepts:

- A `SubagentDiscoverySnapshot` or `SubgraphDiscoverySnapshot`
- A `{ namespace: string[] }` descriptor
- A `Signal<…>` of any of the above — projections rebind automatically
  when the target changes

Omitting `target` reads from the root namespace.

## Example — subagent-scoped messages

```typescript
import { Component, Input } from "@angular/core";
import type { SubagentDiscoverySnapshot } from "@langchain/langgraph-sdk/stream";
import {
  injectMessages,
  injectStream,
  injectToolCalls,
} from "@langchain/angular";

@Component({
  standalone: true,
  selector: "app-subagent-card",
  template: `
    <h4>{{ subagent.name }} ({{ subagent.status }})</h4>
    @for (m of messages(); track m.id ?? $index) {
      <div>{{ str(m.content) }}</div>
    }
    @for (t of toolCalls(); track t.id) {
      <pre>{{ t.name }}: {{ t.status }}</pre>
    }
  `,
})
export class SubagentCardComponent {
  @Input({ required: true }) subagent!: SubagentDiscoverySnapshot;

  readonly stream = injectStream();
  readonly messages = injectMessages(this.stream, () => this.subagent);
  readonly toolCalls = injectToolCalls(this.stream, () => this.subagent);

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }
}
```

## Ref-counting

The first consumer of `injectMessages(stream, subagent)` opens a
scoped subscription; when the last card unmounts, the subscription is
released. Mounting / unmounting subagent cards mid-run is safe — no
manual cleanup required.

## `injectChannel` vs. `injectExtension`

For a `custom:<name>` channel both injectors keep receiving events
across serial runs on the same thread, but they expose different shapes:

- **`injectExtension`** — the **latest** payload only. Use it for
  "current state" panels (progress, score, status).
- **`injectChannel`** — the **full history** of events as a bounded
  buffer. Use it for an event log or to derive your own running totals,
  e.g. `injectChannel(stream, ["custom:redaction-stats"])`.

## Per-event side effects via `injectChannelEffect`

`injectChannel` is for events you **render**. When you instead want to
**react** to each event — fire analytics, write a log — use
`injectChannelEffect`. It invokes `onEvent` once per event and returns
nothing, so it never triggers change detection:

```typescript
import { Component } from "@angular/core";
import { injectStream, injectChannelEffect } from "@langchain/angular";

@Component({
  /* ... */
})
export class AnalyticsComponent {
  readonly stream = injectStream();

  constructor() {
    injectChannelEffect(this.stream, ["lifecycle", "tools"], {
      replay: false,
      onEvent: (event) => sendAnalytics(event),
      onError: (error) => logger.error(error),
    });
  }
}
```

`channels`, `target`, and `enabled` accept `Signal`s so a `computed`
scope re-binds the subscription. The subscription is **shared**
(ref-counted) with any matching `injectChannel`, so you only pay for one
server subscription per channel set. `replay` defaults to `false`
(live-only); events buffered before the effect attaches are not
re-delivered. Call it from an injection context (field initializer,
constructor, or `runInInjectionContext`).

## Media selectors

`injectAudio` / `injectImages` / `injectVideo` / `injectFiles` expose
multimodal streams as signals of media handles. Combine with
`injectMediaUrl(media)` to get a managed `objectURL` that's revoked
when the consuming component is destroyed.

## Related

- [Subagents & subgraphs](./subagents-subgraphs.md)
- [Submission queue](./submission-queue.md)
- [Branching](./branching.md) — uses `injectMessageMetadata`

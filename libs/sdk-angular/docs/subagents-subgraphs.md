# Subagents & subgraphs

`stream.subagents()` / `stream.subgraphs()` /
`stream.subgraphsByNode()` return **discovery snapshots** — id / name
/ namespace / status only. Per-subagent content is read through the
same [selectors](./selectors.md), targeted at the snapshot:

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

The first consumer of `injectMessages(stream, subagent)` opens a
scoped subscription; when the last card unmounts, the subscription is
released.

## Discovery maps

| Signal | Key | Value |
|---|---|---|
| `stream.subagents()` | subagent id | `SubagentDiscoverySnapshot` |
| `stream.subgraphs()` | subgraph id | `SubgraphDiscoverySnapshot` |
| `stream.subgraphsByNode()` | `node` name | `SubgraphDiscoverySnapshot[]` |

The snapshots are intentionally minimal — they carry only identity
and lifecycle metadata (`status: "running" | "done" | "errored"`).
Large payloads like messages, tool calls, and state values stay
behind ref-counted selectors so components only pay for what they
render.

## Rendering a fan-out

```typescript
@Component({
  standalone: true,
  selector: "app-subagent-grid",
  template: `
    @for (sub of subagents() | keyvalue; track sub.key) {
      <app-subagent-card [subagent]="sub.value" />
    }
  `,
})
export class SubagentGridComponent {
  readonly stream = injectStream();
  readonly subagents = this.stream.subagents;
}
```

## Targeting by namespace

If you don't have a snapshot at hand (e.g. the consumer is mounted
before discovery), pass a raw namespace descriptor:

```typescript
readonly messages = injectMessages(this.stream, {
  namespace: ["supervisor", "researcher"],
});
```

`Signal` / factory forms are accepted too — see [Selectors →
Targets](./selectors.md#targets).

## Related

- [Selectors](./selectors.md)
- [Dependency injection](./dependency-injection.md) — publish the
  parent stream so subagent cards can call zero-argument `injectStream()`

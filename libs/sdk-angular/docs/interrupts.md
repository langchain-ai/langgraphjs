# Handling interrupts

`stream.interrupts()` exposes all pending root interrupts.
`stream.interrupt()` is a convenience for the first one. Resume with
`stream.respond(response)` — or target a specific pending interrupt with
`stream.respond(response, options?)`.

```typescript
import { Component } from "@angular/core";
import type { BaseMessage } from "@langchain/core/messages";
import { injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div>{{ str(msg.content) }}</div>
    }

    @if (stream.interrupt(); as pending) {
      <div>
        <p>{{ pending.value.question }}</p>
        <button (click)="onResume()">Approve</button>
      </div>
    }

    <button (click)="onSubmit()">Send</button>
  `,
})
export class ChatComponent {
  readonly stream = injectStream<
    { messages: BaseMessage[] },
    { question: string }
  >({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello" }],
    });
  }

  onResume() {
    void this.stream.respond("Approved");
  }
}
```

## Responding to a specific interrupt

When multiple interrupts are pending, pass `{ interruptId, namespace? }`.
Root interrupts can omit `namespace` (defaults to `[]`). Subgraph
interrupts need the exact tuple from `getThread()?.interrupts`:

```typescript
for (const intr of stream.interrupts()) {
  await stream.respond(decide(intr.value), { interruptId: intr.id! });
}

const thread = stream.getThread();
for (const entry of thread?.interrupts ?? []) {
  await stream.respond(buildResponse(entry.payload), {
    interruptId: entry.interruptId,
    namespace: entry.namespace,
  });
}
```

When `options.interruptId` is omitted, `respond()` walks
`getThread()?.interrupts` from newest to oldest — not necessarily
`stream.interrupt()` (root-only).

Pass `options.config` / `options.metadata` to fold run-level config
(model, user context, …) and metadata (trigger source, test flags, …)
into the run that services the resume, mirroring `submit()`:

```typescript
await stream.respond({ approved: true }, {
  config: { configurable: { model: "gpt-4o" } },
  metadata: { source: "ui" },
});
```

## Changing state while resuming

Pass `options.update` to apply a state update in the **same superstep** as the
resume — it maps to LangGraph's `Command(resume, update)`. The resumed run
produces a single checkpoint reflecting both the resume value and the update:
no separate `updateState` write, no intermediate checkpoint, no flicker.

The canonical use case is a HITL flow where the UI pushes the interrupt card
(e.g. an `AIMessage`) into state at the moment it answers the interrupt, so the
card is committed before the resumed tool runs and stays rendered without the
backend re-emitting it.

`update` accepts a state-keys object (shallow-merged via the graph's channel
reducers) or a list of `[key, value]` entries. Messages under the configured
`messagesKey` may be plain dicts **or** `@langchain/core` `BaseMessage`
instances — instances are serialized to dicts before transport, exactly like
`submit()`. You can also pass `options.goto` for a directed jump
(`Command(goto=...)`) in the same superstep.

```typescript
import { AIMessage } from "@langchain/core/messages";

// Approve the interrupt AND push a message into state in one atomic resume:
await stream.respond(
  { approved: true },
  { update: { messages: [new AIMessage("Approved by reviewer.")] } },
);

// Equivalent with a plain message dict:
await stream.respond(
  { approved: true },
  { update: { messages: [{ type: "ai", content: "Approved by reviewer." }] } },
);
```

## Responding to several interrupts at once

When a run pauses on **several interrupts at the same checkpoint** (e.g.
parallel tool-authorization prompts), resume them in one command with
`respondAll`. Sequential `respond()` calls would fail — the first resume
starts a run, leaving the rest with no interrupted run to respond to.

`responsesById` maps each pending `interruptId` to its response, so
different interrupts can receive different payloads. Namespaces are
resolved internally from `getThread()?.interrupts`, so you only supply
ids. `options.config` / `options.metadata` are folded into the single run
that services the batched resume.

```typescript
// Distinct payloads per interrupt:
await stream.respondAll({
  [interruptA.id]: { approved: true },
  [interruptB.id]: { approved: false },
});

// Same payload to every pending interrupt:
await stream.respondAll(
  Object.fromEntries(stream.interrupts().map((i) => [i.id!, { approved: true }])),
);
```

## Auto-resumed tool interrupts

Interrupts whose target is a registered [headless
tool](./headless-tools.md) are dispatched to the handler and
auto-resumed with the return value. No template plumbing required.

## Typing the interrupt payload

Supply the interrupt shape as the second generic to `injectStream`:

```typescript
readonly stream = injectStream<
  { messages: BaseMessage[] },
  { question: string }        // InterruptType
>({ assistantId: "agent", apiUrl: "…" });
```

See [Type safety](./type-safety.md) for the full generic matrix.

## Related

- [Headless tools](./headless-tools.md)
- [Branching](./branching.md) — editing messages above an interrupt

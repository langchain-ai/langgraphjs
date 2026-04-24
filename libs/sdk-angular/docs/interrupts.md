# Handling interrupts

`stream.interrupts()` exposes all pending root interrupts.
`stream.interrupt()` is a convenience for the first one. Respond by
calling `stream.submit(null, { command: { resume: … } })` — or target
a specific pending interrupt with `stream.respond(response, target?)`.

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
    void this.stream.submit(null, { command: { resume: "Approved" } });
  }
}
```

## Responding to a specific interrupt

When multiple interrupts are pending, pass the target interrupt (or
its id) to `respond`:

```typescript
for (const pending of stream.interrupts()) {
  await stream.respond(decide(pending), pending);
}
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

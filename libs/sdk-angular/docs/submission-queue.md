# Submission queue

Calling `submit` with `multitaskStrategy: "enqueue"` while a run is
already in flight queues the new payload instead of rejecting or
interrupting. `injectSubmissionQueue` exposes the queue as a set of
signals + imperatives:

```typescript
import { Component } from "@angular/core";
import {
  injectStream,
  injectSubmissionQueue,
} from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    @for (msg of stream.messages(); track msg.id ?? $index) {
      <div>{{ str(msg.content) }}</div>
    }

    @if (queue.size() > 0) {
      <div>
        <p>{{ queue.size() }} run(s) queued</p>
        @for (entry of queue.entries(); track entry.id) {
          <button (click)="queue.cancel(entry.id)">
            Cancel {{ entry.id }}
          </button>
        }
        <button (click)="queue.clear()">Clear queue</button>
      </div>
    }

    <button (click)="onSubmit()">Send</button>
  `,
})
export class ChatComponent {
  readonly stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
  readonly queue = injectSubmissionQueue(this.stream);

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit(
      { messages: [{ type: "human", content: "Hello!" }] },
      { multitaskStrategy: "enqueue" },
    );
  }
}
```

## Queue shape

| Field | Type | Notes |
|---|---|---|
| `entries` | `Signal<QueueEntry[]>` | Ordered list of pending payloads. Each entry carries an `id`, the original `input`, and the `options` it was submitted with. |
| `size` | `Signal<number>` | Convenience for `entries().length`. |
| `cancel(id)` | `(id: string) => void` | Remove a specific entry from the queue. |
| `clear()` | `() => void` | Drop all pending entries. |

## Multitask strategies

The `multitaskStrategy` option on `submit` controls what happens when
a run is already in flight:

- `"reject"` (default) — throw synchronously.
- `"interrupt"` — stop the current run and start the new one.
- `"rollback"` — discard the current run's streamed state and restart.
- `"enqueue"` — append to the queue; drain sequentially.

Only `"enqueue"` populates `injectSubmissionQueue`.

## Thread swaps cancel the queue

Swapping `threadId` (via the signal passed to `injectStream`) cancels
all pending runs and clears the queue automatically — you don't have
to call `queue.clear()` yourself.

## Related

- [`injectStream` options](./inject-stream.md#options)
- [Selectors](./selectors.md#ref-counting)

# Submission queue

Calling `submit` with `multitaskStrategy: "enqueue"` while a run is
already in flight queues the new payload instead of rejecting or
interrupting. `injectSubmissionQueue` exposes the queue as a set of
signals + imperatives:

```typescript
import { Component } from "@angular/core";
import { Client } from "@langchain/langgraph-sdk";
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
  readonly client = new Client({ apiUrl: "http://localhost:2024" });
  readonly stream = injectStream({
    assistantId: "agent",
    client: this.client,
    serverQueue: this.client.runs,
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
| `entries` | `Signal<SubmissionQueueEntry[]>` | Ordered list of pending payloads. Each entry carries an `id`, the submitted `values`, and the `options` it was submitted with. |
| `size` | `Signal<number>` | Convenience for `entries().length`. |
| `cancel(id)` | `(id: string) => Promise<boolean>` | Remove a specific entry from the queue. |
| `clear()` | `() => Promise<void>` | Drop all pending entries. |

## Multitask strategies

The `multitaskStrategy` option on `submit` controls what happens when
a run is already in flight:

- `"reject"` — reject the submit promise when a local run is active.
- `"interrupt"` — stop the current run and start the new one.
- `"rollback"` (default) — discard the current run's streamed state and restart.
- `"enqueue"` — send immediately to the server queue.

Local `"enqueue"` submissions and hydrated pending server runs populate `injectSubmissionQueue`.

## Thread swaps detach the queue

Swapping `threadId` clears the local mirror without cancelling accepted server runs.

## Related

- [`injectStream` options](./inject-stream.md#options)
- [Selectors](./selectors.md#ref-counting)

## Server queue semantics

`submit(input, { multitaskStrategy: "enqueue" })` sends the input to the server immediately, even while another run is streaming. Its promise resolves on **server acceptance**, not completion; acceptance failures reject and also reach the per-submit `onError` callback and `stream.error`. The existing content stream stays attached. The server decides execution order; concurrent HTTP requests are not guaranteed to be accepted in invocation order.

Each entry has `{ id, runId?, values, options?, createdAt }`. Use `id` as the stable UI key and cancellation argument. `runId` is absent during acceptance and then contains the real server run ID. Message IDs are assigned before sending and preserved in `values`; queued inputs remain separate from the active run's optimistic state. Entries leave the queue when their own run starts or terminates. Queue completion callbacks are correlated using per-run status/join requests, not another run's terminal event.

Running runs are tracked separately for stop/completion and never appear as pending entries. Pending runs are restored from all pages of `runs.list` on hydration and refreshed on built-in transport reconnects. The SDK checks pending run status roughly once per second and joins running runs without cancelling on disconnect. Restored entries use the server run ID as their UI key. `values` is `undefined` if the server does not return `kwargs.input`; stored input is not guaranteed. Only available config/metadata are restored, not JavaScript callbacks. Hydration includes pending runs submitted by other clients on the same thread.

`cancel(id): Promise<boolean>` cancels that entry's server run, waiting for acceptance if necessary. `clear(): Promise<void>` cancels the current queue snapshot with explicit run IDs, leaving later submissions and unrelated active runs alone. Cancellation failures reject and leave entries available for retry. A run may start between observation and cancellation; cancelling that entry can then interrupt it.

Switching threads or unmounting clears only this client's mirror and detaches observers. **Accepted runs keep executing on their original thread.** Reopening that thread restores its pending queue. To cancel before leaving, explicitly await `clear()`.

Server queues are **opt-in**: pass `serverQueue: client.runs` to the stream options, or implement `transport.serverQueue` on a custom adapter. The capability supplies `list`, `get`, `join`, `cancel`, and `cancelMany`; it must target the same server with the same authentication and fetch policy as the protocol transport. There is no implicit REST fallback. Without it, hydration makes no queue requests and enqueue rejects. Custom adapters can refresh via controller hydration when reconnecting.

Enqueue uses the existing protocol `run.start` command, which configures v2 stream modes, subgraphs, and resumability on both JS and Python servers. It does not use REST `runs.create`. Ordinary (non-enqueue) submissions retain their stream-only completion path and do not acquire GET/join requirements. If their terminal stream event is permanently lost, use reconnect or stop; queue polling is not a general replacement for stream lifecycle delivery.

`stop()` with this capability looks up the current server-running run rather than cancelling pending entries. When no run is running yet, it waits for in-flight local queue acceptances and checks once more. This is not an atomic server-side “cancel whichever run starts next” operation: a run still pending at that check is left alone. Use `cancel(entry.id)` to cancel a specific pending submission. Cancellation failures from `stop()` do not prevent client-side stopping.

With the capability enabled, passive completion callbacks come from observed server run IDs, not anonymous terminal events. Runs created by another client after hydration are discovered on a root running event or reconnect; runs that begin and finish entirely outside these observation windows are not guaranteed callbacks. The embedded protocol-only server does not expose the full queue observation API and is not a supported `serverQueue: client.runs` target.

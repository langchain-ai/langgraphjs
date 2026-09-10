# Submission queue

`multitaskStrategy: "enqueue"` lets the user fire additional submits while another run is in flight. The queue is server-backed and observable through the `useSubmissionQueue` companion hook.

## Table of contents

- [Multitask strategies](#multitask-strategies)
- [Enqueueing runs](#enqueueing-runs)
- [`useSubmissionQueue`](#usesubmissionqueue)
- [Cancelling and clearing](#cancelling-and-clearing)
- [Thread switches](#thread-switches)

## Multitask strategies

Pass `multitaskStrategy` to `submit()` to control what happens when a submit lands while a run is already active:

| Strategy      | Behaviour                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `"rollback"`  | Default. Aborts the active run and immediately dispatches the new one.                                  |
| `"reject"`    | Drops the new submit. The returned promise rejects.                                                     |
| `"enqueue"`   | Sends the submit immediately to the server queue without replacing the active stream. |
| `"interrupt"` | Currently falls back to `"rollback"` semantics client-side, pending server-side support.                |

## Enqueueing runs

Opt in when constructing the stream. Keep the client stable (for example, at module scope) and configure authentication/fetch there so commands and queue requests share it:

```tsx
import { Client } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/react";

const client = new Client({ apiUrl: "http://localhost:2024" });

function Chat() {
  const stream = useStream({ assistantId: "agent", client, serverQueue: client.runs });
  return <button onClick={() => stream.submit({}, { multitaskStrategy: "enqueue" })}>Queue</button>;
}
```

For a fetch/auth shim, construct the client with `callerOptions: { fetch: authenticatedFetch }` and any `defaultHeaders`/`onRequest` hook. A hook-level `fetch` override affects protocol traffic only; configure the queue capability with that same fetch explicitly.

```tsx
import { HumanMessage } from "@langchain/core/messages";

void stream.submit(
  { messages: [new HumanMessage("follow-up")] },
  { multitaskStrategy: "enqueue" },
);
```

The promise resolves when the server accepts the submission. Use `onCompleted` to observe run completion.

## `useSubmissionQueue`

Subscribe to the queue reactively from any component:

```tsx
import {
  useStream,
  useSubmissionQueue,
  type AnyStream,
} from "@langchain/react";
import { HumanMessage } from "@langchain/core/messages";

function Composer({ stream }: { stream: AnyStream }) {
  const { entries, size, cancel, clear } = useSubmissionQueue(stream);

  return (
    <>
      <button
        onClick={() =>
          stream.submit(
            { messages: [new HumanMessage("go")] },
            { multitaskStrategy: "enqueue" },
          )
        }
      >
        Queue turn
      </button>

      {size > 0 && (
        <div>
          <p>{size} queued</p>
          <ol>
            {entries.map((e) => (
              <li key={e.id}>
                pending… <button onClick={() => cancel(e.id)}>cancel</button>
              </li>
            ))}
          </ol>
          <button onClick={clear}>Clear queue</button>
        </div>
      )}
    </>
  );
}
```

### Return shape

| Field        | Type                              | Description                                     |
| ------------ | --------------------------------- | ----------------------------------------------- |
| `entries`    | `readonly SubmissionQueueEntry[]` | All pending entries, ordered by creation time.         |
| `size`       | `number`                          | Alias for `entries.length`.                     |
| `cancel(id)` | `(id: string) => Promise<boolean>`         | Removes one entry by id; returns `true` on hit. |
| `clear()`    | `() => Promise<void>`                      | Empties the queue.                              |

Each `SubmissionQueueEntry` carries `{ id, runId?, values, options?, createdAt }`.

## Cancelling and clearing

- `cancel(id)` cancels the accepted server run for one entry.
- `clear()` empties the queue but does not affect the active run. Pair with `stream.stop()` if you also need to abort the in-flight work.

## Thread switches

Switching `threadId` detaches from the previous queue without cancelling accepted server runs.

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

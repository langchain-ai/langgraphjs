# Submission queue

`multitaskStrategy: "enqueue"` lets the user fire additional submits while another run is in flight. The queue is fully client-side — entries drain sequentially as the active run terminates — and is observable through the `useSubmissionQueue` companion hook.

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
| `"enqueue"`   | Appends the submit to the client-side queue. Entries drain sequentially once the active run terminates. |
| `"interrupt"` | Currently falls back to `"rollback"` semantics client-side, pending server-side support.                |

## Enqueueing runs

```tsx
import { HumanMessage } from "@langchain/core/messages";

void stream.submit(
  { messages: [new HumanMessage("follow-up")] },
  { multitaskStrategy: "enqueue" },
);
```

Nothing special happens on the return value — the promise resolves when the enqueued run eventually completes. You can fire several in a row; they dispatch in call order.

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
| `entries`    | `readonly SubmissionQueueEntry[]` | All pending entries, in dispatch order.         |
| `size`       | `number`                          | Alias for `entries.length`.                     |
| `cancel(id)` | `(id: string) => boolean`         | Removes one entry by id; returns `true` on hit. |
| `clear()`    | `() => void`                      | Empties the queue.                              |

Each `SubmissionQueueEntry` carries `{ id, input, options, enqueuedAt }` so you can render the queued input ahead of its dispatch.

## Cancelling and clearing

- `cancel(id)` removes a single entry. The run is never dispatched.
- `clear()` empties the queue but does not affect the active run. Pair with `stream.stop()` if you also need to abort the in-flight work.

## Thread switches

Switching `threadId` clears the queue — entries were targeted at the previous thread, so dispatching them against the new one would be surprising. This mirrors the legacy `StreamOrchestrator` behaviour.

# Submission queue

A message sent while a run streams waits in a queue, and runs when the current run ends. `useSubmissionQueue` lists what waits, so you can show it and let the user cancel it.

## Table of contents

- [Where submits wait](#where-submits-wait)
- [Multitask strategies](#multitask-strategies)
- [`useSubmissionQueue`](#usesubmissionqueue)
- [Reloads and thread switches](#reloads-and-thread-switches)

## Where submits wait

By default the queue is the server's: a submit made during a run creates a run in the server's queue, behind the current one. A queued message, and an answer given with `respond` during a run, survives a reload and shows in other tabs. The server's queue creates its runs with `POST /threads/{thread_id}/runs`, so a proxy in front of the server must forward that route, with the others `useStream` calls (see [Behind a proxy](./transports.md#behind-a-proxy)).

`useStream({ queue: "local" })` keeps the queue in the page instead, as `@langchain/react` 1.x did: queued submits are sent one at a time once the current run ends, and a reload drops them.

## Multitask strategies

`submit(input, { multitaskStrategy })` says what to do with a run that is already streaming:

| Strategy             | What happens                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| none, or `"enqueue"` | The new run waits in the queue and starts when the current run ends.                                                                      |
| `"interrupt"`        | The server stops the current run mid-step, keeping the steps it finished, cancels the runs queued on the thread, and starts the new one. A tool call the agent had started can be left without its result. |
| `"rollback"`         | Like `"interrupt"`, and the server also deletes the stopped run, as if it never ran.                                                       |
| `"reject"`           | `submit` throws.                                                                                                                          |

`respond` and `respondAll` always wait in the queue, so an answer never cuts a run short.

## `useSubmissionQueue`

```tsx
import { HumanMessage } from "@langchain/core/messages";
import { useSubmissionQueue, type AnyStream } from "@langchain/react";

function Composer({ stream }: { stream: AnyStream }) {
  const { entries, size, cancel, clear } = useSubmissionQueue(stream);

  return (
    <>
      <button
        onClick={() =>
          void stream.submit({ messages: [new HumanMessage("go")] })
        }
      >
        Send
      </button>

      {size > 0 && (
        <div>
          <p>{size} waiting</p>
          <ol>
            {entries.map((entry) => (
              <li key={entry.id}>
                waiting <button onClick={() => void cancel(entry.id)}>cancel</button>
              </li>
            ))}
          </ol>
          <button onClick={() => void clear()}>Cancel all</button>
        </div>
      )}
    </>
  );
}
```

| Field        | Type                                 | Description                                                  |
| ------------ | ------------------------------------ | ------------------------------------------------------------ |
| `entries`    | `readonly SubmissionQueueEntry[]`    | What waits, oldest first.                                    |
| `size`       | `number`                             | `entries.length`.                                            |
| `cancel(id)` | `(id: string) => Promise<boolean>`   | Removes one entry, and cancels its run when it waits on the server. `false` when there is no such entry. |
| `clear()`    | `() => Promise<void>`                | Removes every entry, and cancels the runs that wait on the server. The current run goes on: stop it with `stream.stop()`. |

Each entry has `id`, `values` (the input), `options` (the submit's options) and `createdAt`. With the server's queue, `runId` is the queued run's id, the same as `id`.

## Reloads and thread switches

- **A reload**, with the server's queue, lists the thread's pending runs again, oldest first, and each starts when its turn comes. Their `values` are the runs' input, and their `options` hold only a `command`, such as an answer's.
- **A thread switch** drops what this page queued for the previous thread, and cancels those runs on the server. Runs a reload listed stay on the server, since another tab may have queued them.
- **With `queue: "local"`**, a reload drops the queue.

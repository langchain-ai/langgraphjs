# `useStream`

The root hook of `@langchain/react`. Mount it once per thread. It loads the thread, streams its runs, and gives you the thread's state, messages, tool calls, interrupts, subagents and subgraphs. The [selector hooks](./selectors.md) read the same stream for a subagent's or a subgraph's own view.

## Table of contents

- [Options](#options)
  - [Common options](#common-options)
  - [Agent Server options](#agent-server-options)
- [Return values](#return-values)
- [`submit()`](#submit)
- [Stopping, answering and loading](#stopping-answering-and-loading)
  - [`stop()` and `disconnect()`](#stop-and-disconnect)
  - [`respond(response, options?)`](#respondresponse-options)
  - [`respondAll(responsesById, options?)`](#respondallresponsesbyid-options)
  - [`hydrate(threadId?)` and `hydrationPromise`](#hydratethreadid-and-hydrationpromise)
- [Related](#related)

## Options

Point the hook at an Agent Server with `assistantId` and `apiUrl`, or `assistantId` and a `client`. For a backend that isn't an Agent Server, pass a custom `transport` instead: see [Custom transports](./custom-transport.md).

### Common options

| Option          | Type                                                                                   | Description                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threadId`      | `string \| null`                                                                       | The thread to show. Changing it loads that thread. `null` starts a new thread on the next submit. An id the server doesn't know shows an empty thread, and the first submit creates it with that id. |
| `onThreadId`    | `(threadId: string) => void`                                                           | Called with the id of each thread the stream moves to, including one a submit created.                                                                                                         |
| `onCreated`     | `(info: { runId: string }) => void`                                                    | Called when the server accepts a run this hook started. A custom transport needs a `metadata` event for it, see [The stream](./custom-transport.md#the-stream).                                                                                                                                         |
| `onCompleted`   | `(info: { runId?: string; reason: "success" \| "error" \| "interrupt" \| "stopped" }) => void` | Called when a run's stream ends, with the reason.                                                                                                                                         |
| `initialValues` | `StateType`                                                                            | Values to show before the thread's state is read.                                                                                                                                               |
| `messagesKey`   | `string`                                                                               | The state key that holds the messages. Defaults to `"messages"`.                                                                                                                                |
| `tools`         | `HeadlessToolImplementation[]`                                                         | Tools that run in the browser when the agent interrupts to call one. See [Interrupts](./interrupts.md#headless-tools).                                                                         |
| `onTool`        | `OnToolCallback`                                                                       | Called with the lifecycle events of those tools.                                                                                                                                                |
| `optimistic`    | `boolean`                                                                              | Show a submit's input at once, before the server answers. Defaults to `true`.                                                                                                                   |

The callbacks are read from the latest render, so an inline function sees current state.

### Agent Server options

| Option                            | Type                                                     | Description                                                                                                                       |
| --------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `assistantId`                     | `string`                                                 | Required. The assistant or graph to run.                                                                                          |
| `apiUrl`                          | `string`                                                 | The server's URL.                                                                                                                 |
| `apiKey`                          | `string`                                                 | Sent by the client the hook builds.                                                                                               |
| `client`                          | `Client`                                                 | A client to use instead of building one.                                                                                          |
| `callerOptions`, `defaultHeaders` | `ClientConfig["callerOptions"]`, `ClientConfig["defaultHeaders"]` | Passed to the client the hook builds, and compared by entry. See [Headers and auth](./transports.md#headers-and-auth).   |
| `fetch`                           | `typeof fetch`                                           | Used for every request of the client the hook builds. Ignored, with a warning, when you pass `client`: set it on that client.   |
| `queue`                           | `"server" \| "local"`                                    | Where a submit made during a run waits: in the server's queue (the default) or in this page. See [Submission queue](./submission-queue.md). |
| `maxReconnectAttempts`            | `number`                                                 | Reconnects in a row without an event before a dropped stream fails. Defaults to 5.                                               |
| `reconnectDelayMs`                | `(attempt: number) => number`                            | How long to wait before each reconnect.                                                                                           |
| `onReconnect`, `onConnected`      | callbacks                                                | Called before each reconnect, and after each connection.                                                                          |
| `streamIdleReconnect`             | `number \| "auto"`                                       | Reconnect a stream that goes quiet for this many milliseconds. `0` turns it off.                                                  |
| `transport`                       | `"sse"`                                                  | Server-sent events, the only built-in transport and the default.                                                                  |

### Custom transport options

| Option      | Type                  | Description                                                                                                                |
| ----------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `transport` | `{ stream(payload) }` | Required. Sends each run to your backend, such as a `FetchStreamTransport`. See [Custom transports](./custom-transport.md). |
| `queue`     | `"local"`             | A submit made during a run waits in the page, the only queue there is.                                                     |

The Agent Server options don't compile next to a `transport`.

## Return values

| Property                              | Type                                                        | Description                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `values`                              | `StateType`                                                 | The thread's state: the running run's latest values, or the state last read. `values[messagesKey]` holds `messages`. |
| `messages`                            | `BaseMessage[]`                                             | The main conversation's messages, streamed token by token, as message class instances.                              |
| `toolCalls`                           | `AssembledToolCall[]`                                       | The tool calls in `messages`, each with its `status` and result.                                                    |
| `interrupts`, `interrupt`             | `Interrupt[]`, `Interrupt \| undefined`                     | The interrupts waiting for an answer, nested ones included, each with its `namespace` (`[]` at the root). `interrupt` is the first. |
| `isLoading`                           | `boolean`                                                   | Whether a run is streaming.                                                                                         |
| `isThreadLoading`                     | `boolean`                                                   | Whether the thread's state is being read for the first time.                                                        |
| `hydrationPromise`                    | `Promise<void>`                                             | Settles when the latest thread load is done. It never rejects.                                                      |
| `error`                               | `unknown`                                                   | The latest error: from a run, from a load, or the thread's last step's.                                            |
| `threadId`                            | `string \| null`                                            | The thread shown, or `null` until a submit creates one.                                                             |
| `subagents`                           | `ReadonlyMap<string, SubagentDiscoverySnapshot>`            | The subagents the runs started, by the id of their `task` tool call. See [Subagents](./subagents.md).               |
| `subgraphs`                           | `ReadonlyMap<string, SubgraphDiscoverySnapshot>`            | The subgraphs the runs entered.                                                                                     |
| `subgraphsByNode`                     | `ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>` | The same subgraphs, by the graph node that started them.                                                            |
| `submit(input, options?)`             | function                                                    | Start a run on the thread.                                                                                          |
| `stop(options?)`                      | function                                                    | Stop the run and cancel it on the server.                                                                           |
| `disconnect()`                        | function                                                    | Stop showing the run, and leave it running.                                                                         |
| `respond(response, options?)`         | function                                                    | Answer an interrupt.                                                                                                |
| `respondAll(responsesById, options?)` | function                                                    | Answer several interrupts in one run.                                                                               |
| `hydrate(threadId?)`                  | function                                                    | Load a thread, or read the current one again.                                                                       |
| `getThread()`                         | function                                                    | Deprecated: `{ interrupts, onError }`. Use `interrupts` and `respond`.                                              |
| `client`                              | `Client`                                                    | The client the hook uses. With a custom transport, a client with the default URL, which the hook doesn't use.       |
| `assistantId`                         | `string`                                                    | The assistant the hook runs, or `""` with a custom transport.                                                       |

The functions keep their identity across renders.

## `submit()`

`submit(input, options?)` takes part of the state as input. Messages can be plain objects or `BaseMessage` instances, and the input shows at once unless `optimistic` is `false`. A thread is created first when there is none.

| Option                              | Type                                                 | Description                                                                                                              |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `config`                            | `{ configurable?, tags?, recursion_limit?, ... }`    | The run's config.                                                                                                        |
| `metadata`                          | `Record<string, unknown>`                            | The run's metadata.                                                                                                      |
| `multitaskStrategy`                 | `"enqueue" \| "interrupt" \| "rollback" \| "reject"` | What to do with a run that is already streaming. With none, the new run waits behind it. See [Submission queue](./submission-queue.md). |
| `forkFrom`                          | `string`                                             | Run from this checkpoint instead of the thread's latest, to edit or retry. See [Fork from a checkpoint](./fork-from-checkpoint.md). |
| `threadId`                          | `string \| null`                                     | Submit to this thread instead, loading it first. Later submits stay on it until the hook's `threadId` changes.          |
| `onError`                           | `(error: unknown) => void`                           | Called when this run fails.                                                                                              |
| `command`                           | `Command`                                            | Resume, update or route the graph instead of sending input. To answer an interrupt, use `respond`.                       |
| `interruptBefore`, `interruptAfter` | `"*" \| string[]`                                    | Pause before or after these nodes. `submit(null)` continues. See [Breakpoints](./interrupts.md#breakpoints).             |
| `signal`                            | `AbortSignal`                                        | Accepted and ignored. Stop a run with `stop()`.                                                                          |

`submit()` resolves when the run's stream ends, or, for a submit that waits behind another run, once it is queued. It doesn't reject when the run fails: the error goes to `error` and to `onError`. With `multitaskStrategy: "reject"`, it throws while a run streams.

## Stopping, answering and loading

### `stop()` and `disconnect()`

`stream.stop()` stops the run this page shows and cancels it on the server, whether this page started it or joined it after a reload or from another tab. What streamed so far stays on screen. With no run, it does nothing.

```tsx
<button onClick={() => void stream.stop()} disabled={!stream.isLoading}>
  Stop
</button>
```

`stream.disconnect()`, the same as `stop({ cancel: false })`, stops showing the run and leaves it running on the server. Loading the thread again joins it.

### `respond(response, options?)`

Answers one interrupt: `options.interruptId`, or the one `stream.interrupt` shows. The answer finds the interrupt by its id, nested ones included. During a run, the answer waits in the queue behind it. `respond` resolves once the answer's run is created or queued.

```tsx
// One interrupt waiting:
await stream.respond({ approved: true });

// Several waiting: name the one to answer.
await stream.respond({ approved: true }, { interruptId: interrupt.id });

// Carry run config and metadata onto the run that resumes:
await stream.respond(
  { approved: true },
  {
    config: { configurable: { user_id: "u_123" } },
    metadata: { source: "ui" },
  }
);
```

Options: `interruptId`, `config`, `metadata`, `update` and `goto` (applied with the answer, see [Interrupts](./interrupts.md#changing-state-while-answering)), and `strictResume`, on by default: on a server that checks answers (Agent Server 0.19 or later, with a Python graph), an answer to an interrupt that is no longer waiting fails its run instead of being ignored. `namespace` is accepted and ignored.

### `respondAll(responsesById, options?)`

Answers several interrupts waiting at the same checkpoint, such as parallel approvals, in one run. Answering them one by one with `respond` doesn't work: the first answer starts a run, and the others have nothing left to resume.

```tsx
await stream.respondAll({
  [interruptA.id!]: { approved: true },
  [interruptB.id!]: { approved: false },
});
```

It takes the same options as `respond`, except `interruptId`.

### `hydrate(threadId?)` and `hydrationPromise`

`stream.hydrate(threadId)` loads another thread, as a `threadId` prop change does. With no argument, it reads the current thread again, for example after a write made outside the stream. Either way it joins the thread's running run, and resolves when the load is done.

`stream.hydrationPromise` settles when the latest load is done, the running run lookup included. It never rejects: a failed load sets `error`. [`useSuspenseStream`](./suspense.md) suspends on it, and you can use it to hold a skeleton until the first state shows:

```tsx
useEffect(() => {
  let cancelled = false;
  void stream.hydrationPromise.then(() => {
    if (!cancelled) setHydrated(true);
  });
  return () => {
    cancelled = true;
  };
}, [stream.hydrationPromise]);
```

## Related

- [Selector hooks](./selectors.md)
- [Interrupts and headless tools](./interrupts.md)
- [Submission queue](./submission-queue.md)
- [Transports](./transports.md)
- [Type safety](./type-safety.md)

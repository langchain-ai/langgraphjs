# Migrating from `@langchain/react` 1.x to 2.0

2.0 keeps 1.x's hooks, their names and their arguments. What changes is underneath: the hooks run on the stream engine of `@langchain/langgraph-sdk/ui`, over the Agent Server's run streams, instead of the event streaming protocol 1.x used. Most apps upgrade by changing the version.

This page lists every change a 1.x app may notice, and how to get 1.x's behavior back where there is a way.

## Table of contents

- [Before you upgrade](#before-you-upgrade)
- [Removed](#removed)
- [What works differently](#what-works-differently)
- [What's new](#whats-new)
- [What stays the same](#what-stays-the-same)
- [Types](#types)
- [Coming from 0.x](#coming-from-0x)

## Before you upgrade

**The SDK.** 2.0 depends on the exact `@langchain/langgraph-sdk` version it was released with (1.16 or later). If your app imports the SDK too, use that version.

**The server.** 2.0 works with any Agent Server, `langgraph dev` included. Its full behavior needs Agent Server 0.19 or later:

- each subagent panel streams only its own subagent,
- a reload joins a running run where the loaded state ends, without replaying the run,
- tool events reach the `tools` channel,
- an answer to an interrupt that is no longer waiting fails, instead of being ignored,
- a card answered in another tab disappears at once.

On an older server, 2.0 still works: subagent panels get every event of each run (a console warning says so once), and a reload replays the running run from its start.

## Removed

### Media hooks

`useAudio`, `useImages`, `useVideo`, `useFiles`, `useMediaURL`, `useAudioPlayer`, `useVideoPlayer`, `MediaAssemblyError` and the media and player types are gone. Images, audio and files a model returns are in its message's content, as the model sends them: read them from `message.content` or `message.contentBlocks` once the message is complete. For example, to play audio and show images:

```tsx
function MessageMedia({ message }: { message: BaseMessage }) {
  return message.contentBlocks.map((block, i) => {
    if (block.type !== "image" && block.type !== "audio") return null;
    const src =
      block.url ??
      (typeof block.data === "string"
        ? `data:${block.mimeType};base64,${block.data}`
        : undefined);
    if (src == null) return null;
    return block.type === "image" ? (
      <img key={i} src={src} alt="" />
    ) : (
      <audio key={i} controls src={src} />
    );
  });
}
```

Data that arrives as bytes (a `Uint8Array`) needs a URL of its own, such as `URL.createObjectURL(new Blob([new Uint8Array(block.data)], { type: block.mimeType }))`.

### `useExtension`

Named custom channels (`custom:<name>`) are gone. Every event a graph writes arrives on the `custom` channel as `{ payload: <what it wrote> }`. To keep the latest value of a named event, for a graph that writes `{ name: "status", payload: ... }`:

```tsx
// 1.x
const status = useExtension<Status>(stream, "status");

// 2.0
const [status, setStatus] = useState<Status>();
useChannelEffect(stream, ["custom"], {
  onEvent(event) {
    if (event.method !== "custom") return;
    const written = event.params.data.payload as {
      name?: string;
      payload?: Status;
    };
    if (written?.name === "status") setStatus(written.payload);
  },
});
```

Channels a graph published through stream transformers (`StreamChannel`) exist only in 1.x's protocol, so 2.0 can't receive them. Write those events with the graph's stream writer instead (`runtime.writer` in LangGraph JS, `get_stream_writer()` in Python).

### `useProjection`

Use the [selector hooks](./selectors.md).

### The WebSocket transport

`transport: "websocket"` and `webSocketFactory` are gone. 2.0 streams over HTTP with server-sent events, 1.x's default. To add headers, use `defaultHeaders`, `callerOptions` or `fetch` (see [Transports](./transports.md)).

### Custom adapters

`AgentServerAdapter`, `HttpAgentServerAdapter`, `HttpAgentServerAdapterOptions` and `CustomAdapterOptions` are gone. A custom backend passes `transport: { stream(payload) }`, to `useStream` or `StreamProvider`, and returns the same stream the Agent Server sends. `CustomTransportOptions` types those options, and `StreamProviderCustomProps` the provider's. See [Custom transports](./custom-transport.md).

### `getThread()`

1.x returned the protocol's `ThreadStream`, with `subscribe` and the thread's `run`, `input` and `state` commands. In 2.0, `getThread()` is deprecated. It returns `undefined` before the stream has a thread, and then a `StreamThread` with only `interrupts`, each waiting interrupt as `{ interruptId, namespace, payload }`, and `onError(listener)`. Read `stream.interrupts` and answer with `stream.respond()` instead. For what `subscribe` gave, use `useChannel` or `useChannelEffect`.

### Channels

`useChannel` and `useChannelEffect` take `values`, `updates`, `messages`, `custom`, `tools` and `lifecycle`. `custom:<name>`, `input`, `checkpoints` and `tasks` are gone. What changed in the others is under [Channel events](#channel-events).

## What works differently

### A message sent during a run waits

- **1.x:** a submit while a run streamed asked the server to stop that run and start the new one: its default `multitaskStrategy` was `"interrupt"`.
- **2.0:** it waits in a queue, the server's by default or this tab's with `queue: "local"`, and runs when the current run ends. Nothing is cut short, and the message shows in `useSubmissionQueue` until its run starts.
- **Back:** pass `multitaskStrategy: "interrupt"` on that submit. The server then stops the current run mid-step and cancels the runs queued on the thread. A tool call the agent had started can be left without its result.

### The queue lives on the server

- **1.x:** a submit queued with `multitaskStrategy: "enqueue"` waited in the page, unless you set `queue: "server"`.
- **2.0:** a queued submit is a run in the server's queue, so a queued message, and an answer given during a run, survives a reload and shows in other tabs. `cancel()` and `clear()` cancel those runs. After a reload, the queue lists the thread's pending runs.
- **Back:** `useStream({ queue: "local" })`.

### `stop()` also cancels runs this page didn't start

- **1.x:** `stop()` cancelled only a run started in this page.
- **2.0:** it cancels the run this page shows, also after a reload, or when another tab or a cron started it.
- **Back:** `disconnect()` stops showing the run and leaves it running.

### New threads are created before their first run

- **1.x:** the first submit made a thread id in the browser, `onThreadId` fired at once, and the run created the thread.
- **2.0:** the first submit shows its message at once, creates the thread with `POST /threads`, then starts the run. Your server's `threads.create` auth handler runs, so the thread gets its owner. `onThreadId` fires once the thread exists.
- **Back:** to have the id at once, make it yourself and pass it as `threadId`. An id the server doesn't know shows an empty thread, and the first submit creates the thread with that id.

### `onThreadId` fires on every thread change

- **1.x:** only for a new thread.
- **2.0:** also when the `threadId` prop or a submit's `threadId` moves the stream to another thread.

### `fetch`

- **1.x:** `fetch` was used for the stream only, also when you passed `client`.
- **2.0:** it is used for every request of the client the hook builds: thread reads, runs and cancels. With `client` it is ignored, with a warning in the console.
- **Back:** set it on your client: `new Client({ apiUrl, callerOptions: { fetch } })`.

### A late answer fails

- **1.x:** an answer to an interrupt that is no longer waiting (answered in another tab, or a wrong id) started no run. The Agent Server rejected it, and `respond()` failed with its error. The JS dev server ignored it.
- **2.0:** `respond` and `respondAll` ask for strict answers by default. On a server that supports them (the version under [Before you upgrade](#before-you-upgrade), with a Python graph), such an answer fails its run with an `UnknownInterruptError` and leaves the thread as it was.
- **Back:** `respond(value, { strictResume: false })`.

### `respond()` with no id answers `interrupt`

- **1.x:** it answered the newest interrupt not answered yet, which wasn't always the one `stream.interrupt` showed.
- **2.0:** it answers the one `stream.interrupt` shows.
- **Back:** pass the `interruptId` of the interrupt to answer.

### A nested interrupt's `namespace` after a load

- **1.x:** after a load, `getThread().interrupts` gave a nested interrupt's whole namespace.
- **2.0:** after a load, a nested interrupt's `namespace` names only its top subgraph, in `getThread().interrupts` and `stream.interrupts`. While a run streams, it is the whole one. Answers go by `interruptId`, so this matters only to code that reads the namespace.

### `error` shows the thread's last error after a load

- **1.x:** `error` held errors from this page's runs and loads.
- **2.0:** it also shows the error of the thread's last step when a thread loads, so a thread whose last run failed shows the error after a reload. A run stopped from another tab reads as failed too. The error stays until a later run's state replaces it.

### `getThread().onError` also fires for failed runs

- **1.x:** it fired only when the stream itself failed, as when reconnecting gave up.
- **2.0:** it also fires when a run fails.

### `useSuspenseStream` throws only a failed load

- **1.x:** it threw any error to the error boundary once no run was streaming.
- **2.0:** it throws when the thread fails to load. A run's error stays in `error`, so the conversation stays on screen.
- **Back:** `if (stream.error) throw stream.error;` in your component.

### A server render reads no thread

- **1.x:** a server render, in Next.js and the like, read the thread on the server, without the user's cookies or auth.
- **2.0:** it reads no thread. `useStream` shows the `threadId` it's given as loading, and `useSuspenseStream` renders its Suspense fallback through an error that Next.js doesn't report (see [Server rendering](./suspense.md#server-rendering)). The browser reads the thread after hydration.

### `values.messages` streams token by token

- **1.x:** `values[messagesKey]` changed once per step, while `messages` streamed tokens.
- **2.0:** `values[messagesKey]` holds the same token-streamed messages as `messages`. So `values` is a new object on every token: an effect or a memo should depend on the fields it uses, such as `values.todos`, not on `values`.

### `values` has only the graph's keys

- **1.x:** `values` had an empty `messages` key for a graph without one.
- **2.0:** it holds only the graph's own keys.
- **Back:** read `stream.messages`, which is `[]` for such a graph.

### A streaming message's `content` is the server's

- **1.x:** a message's `content` was an array of content blocks while it streamed, built from 1.x's events, and what the server saved after a reload. In a JS graph, runs 1.x started also made a model that streams return content blocks to the node that called it.
- **2.0:** `content` is what the server streams and saves, while it streams and after a reload, so a plain text reply's is a string. In runs 2.0 starts, a model called in a JS graph's node returns its usual content. `message.text` gives the same text on both.

### Fork points arrive after a run

- **1.x:** `useMessageMetadata(stream, id).parentCheckpointId` came with the stream.
- **2.0:** it is read from the thread's history when a run ends or a thread loads, one small request, so a message has none while it streams. Messages more than about 500 steps back get none, so hide their edit button.

### Subgraphs after a reload

- **1.x:** `subgraphs` and `subgraphsByNode` were rebuilt from history on load.
- **2.0:** they start empty after a reload and fill as runs stream them.

### A fork-mode subagent's panel leaves out the main conversation's messages

- **1.x:** a panel on a deep agents subagent with `mode="fork"` also showed the main conversation's messages, which the subagent starts from.
- **2.0:** it shows only the subagent's own messages. A subgraph's panel shows all its messages, as in 1.x.

### A subagent's `output` is its text

- **1.x:** a finished subagent's `output` was the `task` tool's result as the server sent it, in a shape that differed by server.
- **2.0:** it is the text of its `task` tool message, what the subagent answered. For the state or files a subagent wrote, read `useValues(stream, subagent)`.

### A subagent's `namespace` after a reload

- **1.x:** after a reload, each subagent showed its own namespace.
- **2.0:** a subagent's `namespace` is its own when its `task` tool message records it, as deepagents does from 0.7.36 in Python and 1.16.5 in JS. Otherwise it is `["tools:<tool call id>"]` until the real one is known, which the first hook given that subagent looks up. Hooks given the subagent or its `namespace` work either way, and `depth` is right from the start. To key a list, use `subagent.id`, which doesn't change.

### Runs started elsewhere

- **1.x:** a thread followed runs started elsewhere only once it was active (a run streaming or an interrupt waiting) or had sent a message.
- **2.0:** every loaded thread keeps one connection to the server, so runs started in another tab, by a cron or from Slack show as they stream. The connection pauses while the page is hidden or its own run streams. The JS dev server (`langgraphjs dev`) has no stream to follow, so there such runs show at the next load.
- **Back:** `useStream({ watchThread: false })` keeps no such connection, and those runs show at the next load or `hydrate()`.

### Channel hooks start when they mount

- **1.x:** `useChannel` first replayed the run's earlier events from the server, and so did `useChannelEffect` with `replay: true`.
- **2.0:** both get events from when they mount, and a hook on `tools` gets none from a run that was already streaming. `useChannel` drops its events when the stream moves to another thread. `replay` is deprecated and does nothing.
- **Back:** none for events from before the page loaded. Call the hook in the component that calls `useStream`, so it sees each run this page starts from its beginning.

### Channel events

- A hook gets the events at its target's namespace, and the `lifecycle` events of the subagents and subgraphs the target starts. 1.x's hook on the main conversation also got the `values`, `updates` and `custom` events of its direct subgraphs and subagents, and, with a Python graph, their `messages` and `tools` events too. To get those, pass the subgraph or subagent as the target.
- `messages` gives each message chunk as a `[chunk, metadata]` pair, as the Agent Server streams it, not 1.x's content-block events (`message-start`, `content-block-delta` and the rest).
- `tools` keeps `tool-started`, `tool-finished` and `tool-error`, and `tool-progress` with `data` replaces `tool-output-delta`. Tool events need the server version under [Before you upgrade](#before-you-upgrade).
- `lifecycle` has the events of subagents and subgraphs, and one event when a run ends: `completed`, `interrupted` or `failed`. No event says a run started.
- `custom` gives `{ payload }`, where `payload` is what the graph wrote.
- `params.timestamp` is when the page received the event.
- Events have no `type`, `event_id` or `seq`, and `params` has no `node`. A `messages` event's metadata names the node as `langgraph_node`.
- In `useChannelEffect`, an `onEvent` that throws is logged with `console.error` when there is no `onError`. 1.x dropped it.

## What's new

- `stream.hydrate(threadId?)` loads a thread, or reads the current one again, and joins its running run. Reading the current one again leaves `isThreadLoading` `false`, so the thread stays on screen. 1.x's `stream[STREAM_CONTROLLER].hydrate()` set it while it read.
- `submit()` takes `command`, `interruptBefore` and `interruptAfter`.
- The selector hooks accept a `useSuspenseStream` result, and `StreamLike` types a helper that takes either kind of stream.
- With a typed agent (`useStream<typeof agent>`), `useValues` and `useSubmissionQueue` give the agent's state. 1.x typed it as the agent itself.
- `useStreamContext` takes the interrupt and `configurable` types, as `useStream` does.
- Callbacks (`onThreadId`, `onCreated`, `onCompleted`, `onTool` and the reconnect callbacks) are read from the latest render, so they see current state. 1.x kept the first render's.
- `onCompleted` gets the `runId` of a run the hook joined, such as one still running after a reload. 1.x's had none.
- `submit`, `stop`, `respond` and the stream's other functions keep their identity across renders.
- `defaultHeaders` and `callerOptions` are compared by entry, so an inline object keeps the client while its values stay the same. 1.x built a new client for each new object. A function written inline in `callerOptions` still builds one on every render.

## What stays the same

- The hooks, their names and arguments, and `StreamProvider` and `useStreamContext`.
- `useSubmissionQueue`'s entries, `cancel` and `clear`.
- The fields of the subagent snapshots in `stream.subagents`. Only what `output` holds, and `namespace` after a reload, changed (see [What works differently](#what-works-differently)).
- Headless tools (`tools` and `onTool`).
- Nested interrupts show in `interrupts`.
- Runs keep going when the tab closes, and a reload joins the running run.

## Types

- Gone with their functions: the media and player types, `AgentServerAdapter`, `HttpAgentServerAdapterOptions` and `CustomAdapterOptions`. `StreamProviderCustomProps` stays, for a custom `transport` instead of an adapter.
- `stream.subagents` is keyed by `string`, the `task` tool call's id, as it was at runtime in 1.x, whose types said the keys were subagent names. To find a subagent by name, read its `name` field.
- `submit()`'s `signal` and `respond()`'s `namespace` are deprecated and do nothing. Stop a run with `stop()`. An interrupt's `interruptId` is enough to answer it.
- `Channel` and `Event` are `@langchain/react`'s own types for 2.0's channels, not `@langchain/protocol`'s.
- `stream[STREAM_CONTROLLER]` is internal, and holds 2.0's engine, a `StreamOrchestrator` (a `CustomStreamOrchestrator` with a custom transport), instead of 1.x's `StreamController`, so code that read its members, such as `registry`, has to change. Its `hydrate()` is the same as `stream.hydrate()`.
- New: `CustomTransportOptions`, `RunCompletedInfo`, `RunExecutionInfo`, `RunExecutionReason`, `StreamRespondOptions`, `StreamRespondAllOptions`, `UseStreamCommonOptions`, `UseChannelOptions`, `StreamLike` and `StreamThread`.

## Coming from 0.x

2.0 keeps 1.x's API, so follow the [1.x migration guide](https://github.com/langchain-ai/langgraphjs/blob/@langchain/react@1.2.13/libs/sdk-react/docs/v1-migration.md) first, then this page.

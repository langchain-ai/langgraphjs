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

`AgentServerAdapter`, `HttpAgentServerAdapter`, `HttpAgentServerAdapterOptions` and `CustomAdapterOptions` are gone. A custom backend passes `transport: { stream(payload) }`, to `useStream` or `StreamProvider`, and returns the same stream the Agent Server sends. See [Custom transports](./custom-transport.md).

### `getThread()`

1.x returned the protocol's `ThreadStream`, with `subscribe` and the thread's `run`, `input` and `state` commands. In 2.0, `getThread()` is deprecated. It returns `undefined` before the stream has a thread, and then a `StreamThread` with only `interrupts`, each waiting interrupt as `{ interruptId, namespace, payload }`, and `onError(listener)`. Read `stream.interrupts` and answer with `stream.respond()` instead. For what `subscribe` gave, use `useChannel` or `useChannelEffect`.

### Channels

`useChannel` and `useChannelEffect` take `values`, `updates`, `messages`, `custom`, `tools` and `lifecycle`. `custom:<name>`, `input`, `checkpoints` and `tasks` are gone. What changed in the others is under [Channel events](#channel-events).

## What works differently

### A message sent during a run waits

- **1.x:** a submit while a run streamed interrupted that run.
- **2.0:** it waits in the queue and runs when the current run ends. Nothing is cut short, and the message shows in `useSubmissionQueue` until its run starts.
- **Back:** pass `multitaskStrategy: "interrupt"` on that submit. The server then stops the current run mid-step and cancels the runs queued on the thread. A tool call the agent had started can be left without its result.

### The queue lives on the server

- **1.x:** a queued submit waited in the page.
- **2.0:** it is a run in the server's queue, so a queued message, and an answer given during a run, survives a reload and shows in other tabs. `cancel()` and `clear()` cancel those runs. After a reload, the queue lists the thread's pending runs.
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

- **1.x:** an answer to an interrupt that is no longer waiting (answered in another tab, or a wrong id) was ignored, unless you set `strictResume: true`.
- **2.0:** `respond` and `respondAll` ask for strict answers by default. On a server that supports them (the version under [Before you upgrade](#before-you-upgrade), with a Python graph), such an answer fails its run with an `UnknownInterruptError` and leaves the thread as it was.
- **Back:** `respond(value, { strictResume: false })`.

### `respond()` with no id answers `interrupt`

- **1.x:** it answered the newest interrupt not answered yet, which wasn't always the one `stream.interrupt` showed.
- **2.0:** it answers the one `stream.interrupt` shows.
- **Back:** pass the `interruptId` of the interrupt to answer.

### `error` shows the thread's last error after a load

- **1.x:** `error` held errors from this page's runs and loads.
- **2.0:** it also shows the error of the thread's last step when a thread loads, so a thread whose last run failed shows the error after a reload. A run stopped from another tab reads as failed too. The error stays until a later run's state replaces it.

### `useSuspenseStream` throws only a failed load

- **1.x:** it threw any error to the error boundary once no run was streaming.
- **2.0:** it throws when the thread fails to load. A run's error stays in `error`, so the conversation stays on screen.
- **Back:** `if (stream.error) throw stream.error;` in your component.

### `values.messages` streams token by token

- **1.x:** `values[messagesKey]` changed once per step, while `messages` streamed tokens.
- **2.0:** `values[messagesKey]` holds the same token-streamed messages as `messages`.

### Fork points arrive after a run

- **1.x:** `useMessageMetadata(stream, id).parentCheckpointId` came with the stream.
- **2.0:** it is read from the thread's history when a run ends or a thread loads, one small request, so a message has none while it streams. Messages more than about 500 steps back get none, so hide their edit button.

### Subgraphs after a reload

- **1.x:** `subgraphs` and `subgraphsByNode` were rebuilt from history on load.
- **2.0:** they start empty after a reload and fill as runs stream them.

### Runs started elsewhere

- **1.x:** a thread followed runs started elsewhere only once it was active (a run streaming or an interrupt waiting) or had sent a message.
- **2.0:** every loaded thread keeps one connection to the server, so runs started in another tab, by a cron or from Slack show as they stream. The connection pauses while the page is hidden or its own run streams. The JS dev server (`langgraphjs dev`) has no stream to follow, so there such runs show at the next load.

### Channel hooks start when they mount

- **1.x:** `useChannel` first replayed the run's earlier events from the server, and so did `useChannelEffect` with `replay: true`.
- **2.0:** both get events from when they mount, and a hook on `tools` gets none from a run that was already streaming. `useChannel` drops its events when the stream moves to another thread. `replay` is deprecated and does nothing.
- **Back:** none for events from before the page loaded. Call the hook in the component that calls `useStream`, so it sees each run this page starts from its beginning.

### Channel events

- `messages` gives each message chunk as a `[chunk, metadata]` pair, as the Agent Server streams it, not 1.x's content-block events (`message-start`, `content-block-delta` and the rest).
- `tools` keeps `tool-started`, `tool-finished` and `tool-error`, and `tool-progress` with `data` replaces `tool-output-delta`. Tool events need the server version under [Before you upgrade](#before-you-upgrade).
- `lifecycle` has the events of subagents and subgraphs, and one event when a run ends: `completed`, `interrupted` or `failed`. No event says a run started.
- `custom` gives `{ payload }`, where `payload` is what the graph wrote.
- `params.timestamp` is when the page received the event.
- In `useChannelEffect`, an `onEvent` that throws is logged with `console.error` when there is no `onError`. 1.x dropped it.

## What's new

- `stream.hydrate(threadId?)` loads a thread, or reads the current one again, and joins its running run.
- `submit()` takes `command`, `interruptBefore` and `interruptAfter`.
- The selector hooks accept a `useSuspenseStream` result.
- Callbacks (`onThreadId`, `onCreated`, `onCompleted`, `onTool` and the reconnect callbacks) are read from the latest render, so they see current state. 1.x kept the first render's.
- `submit`, `stop`, `respond` and the stream's other functions keep their identity across renders.
- `defaultHeaders` and `callerOptions` are compared by entry, so an inline object keeps the client while its values stay the same. 1.x built a new client for each new object. A function written inline in `callerOptions` still builds one on every render.

## What stays the same

- The hooks, their names and arguments, and `StreamProvider` and `useStreamContext`.
- `useSubmissionQueue`'s entries, `cancel` and `clear`.
- The subagent snapshots in `stream.subagents`, and their fields.
- Headless tools (`tools` and `onTool`).
- Nested interrupts show in `interrupts`.
- Runs keep going when the tab closes, and a reload joins the running run.

## Types

- Gone with their functions: the media and player types, `AgentServerAdapter`, `HttpAgentServerAdapterOptions` and `CustomAdapterOptions`.
- `Channel` and `Event` are `@langchain/react`'s own types for 2.0's channels, not `@langchain/protocol`'s.
- `stream[STREAM_CONTROLLER]` is internal, and holds 2.0's engine, a `StreamOrchestrator`, instead of 1.x's `StreamController`, so code that read its members, such as `registry`, has to change. Its `hydrate()` is the same as `stream.hydrate()`.
- New: `RunCompletedInfo`, `RunExecutionInfo`, `RunExecutionReason`, `StreamRespondOptions`, `StreamRespondAllOptions`, `UseStreamCommonOptions`, `UseChannelOptions` and `StreamThread`.

## Coming from 0.x

2.0 keeps 1.x's API, so follow the [1.x migration guide](https://github.com/langchain-ai/langgraphjs/blob/@langchain/react@1.2.13/libs/sdk-react/docs/v1-migration.md) first, then this page.

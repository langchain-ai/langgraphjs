# @langchain/langgraph-sdk

## 1.17.0

### Minor Changes

- [#3355](https://github.com/langchain-ai/langgraphjs/pull/3355) [`b2bc8eb`](https://github.com/langchain-ai/langgraphjs/commit/b2bc8eb322c869825e82d68186caf1c9424e8fc2) Thanks [@eliornl](https://github.com/eliornl)! - `CustomStreamOrchestrator` (`@langchain/langgraph-sdk/ui`), the engine for custom transports:
  
  - A submit stays on the thread the first one created, also one made while that run streams. Every submit after the first started a new thread.
  - A submit keeps the values shown and shows its input at once, instead of showing `initialValues` until the server answered. The messages shown at once go to the transport as dicts with ids, so the server's copy replaces them, and a backend should keep those ids. `optimistic: false` shows nothing early and sends the input as passed. `initialValues` show until a run streams, and only on the first thread.
  - A submit made during a run is listed in `queueEntries` until its turn. `cancelQueueItem()`, `clearQueue()`, a thread switch and `stop()` drop it before it starts.
  - `respond()` and `respondAll()` send answers through the transport as a resume command, and hide the answered interrupts until that run ends. Without an id, `respond()` answers the interrupt `interrupt` shows, the first one. `respondAll()` resolves once its run starts.
  - `hydrate(threadId)` switches to that thread and reads nothing, since a custom transport has no thread routes.
  - `StreamEngine` is the interface a framework binding uses, and both `StreamOrchestrator` and `CustomStreamOrchestrator` implement it.

- [#3364](https://github.com/langchain-ai/langgraphjs/pull/3364) [`dd0c346`](https://github.com/langchain-ai/langgraphjs/commit/dd0c346df9f77446f0fd61491fa1a45970ae1cdf) Thanks [@eliornl](https://github.com/eliornl)! - `ToolCallStatus` has a fourth value, `"incomplete"`: the call has no result, and no run can still give one, because the run stopped, failed, or waits on an interrupt, or a later message closed the call's turn. `seedToolCallsFromMessages` gives it to such calls. Pass `{ isLoading: false }` when no run streams. It defaults to `true`, which leaves the calls of the latest turn `"running"` as before. Calls assembled from `tools` events don't get it. On 1.x bindings, a subagent panel loaded from history now shows an earlier turn's unanswered call as `"incomplete"`. Code that switches over every `ToolCallStatus` needs a case for the new value.

- [#3370](https://github.com/langchain-ai/langgraphjs/pull/3370) [`77bf3db`](https://github.com/langchain-ai/langgraphjs/commit/77bf3db1b81e7f30d341e4e8bc56d264e41cb341) Thanks [@richardscarrott](https://github.com/richardscarrott)! - `useStream` accepts `stateKeys`, the `values` keys your UI reads. Opening a thread then sends `select` on `GET /threads/{thread_id}/state` for those keys, the messages key, and the top-level fields the hook reads itself, so the server can skip the rest of the state. `stream.values` contains only those keys plus the messages key, after loading and while a run streams, including on a server that ignores `select`. A custom adapter's `getState` receives `{ select }`, and `HttpAgentServerAdapter` forwards it. Without `stateKeys`, nothing changes.

### Patch Changes

- [#3384](https://github.com/langchain-ai/langgraphjs/pull/3384) [`62e40b9`](https://github.com/langchain-ai/langgraphjs/commit/62e40b998f769ccf9d872d394d2fd3d6796a0ddf) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` no longer takes the frames of a run `@langchain/react` 1.x started for its state. A page that moved to `@langchain/react` 2.0 while such a run went on joined it, by opening its thread, by joining a run 1.x queued, or when its thread watcher saw the run start. On the Agent Server its messages then went away until the run ended. On the JS dev server it stopped loading before the run ended and missed the run's last message until a reload.
  
  Now such a run's join reads only its `metadata`, `error` and `end` events. The page keeps what it showed and stays loading until the run ends, then shows the thread's state. A subagent panel open meanwhile reads its history instead of joining the run. These runs are told apart by the run the engine lists or reads before it joins, with no other request.

- [#3376](https://github.com/langchain-ai/langgraphjs/pull/3376) [`feb9832`](https://github.com/langchain-ai/langgraphjs/commit/feb9832ee5c1438f5f403afa9e00b0d9ce6b934f) Thanks [@eliornl](https://github.com/eliornl)! - When a `StreamOrchestrator` run ends without sending `values`, such as one whose assistant doesn't exist, the keys other than messages that its submit showed at once go back to what they were, or away if they were new. Its message stays, marked `failed`. A stopped run leaves them to the stop's read of the thread, and a run that sent `values` shows the server's, as before.

- [#3375](https://github.com/langchain-ai/langgraphjs/pull/3375) [`6033cc7`](https://github.com/langchain-ai/langgraphjs/commit/6033cc746bebf962cb0120e06499a838a512bac3) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` creates the runs of submits made during a run one after another, in submit order. It sent each create at once, so the server could queue, and run, them in the order the requests arrived. A create that fails doesn't hold back the next one, and `clearQueue()` or a thread switch drops the submits still waiting for theirs and cancels the run of one whose create was on its way. A queued run whose create returns after the run before it ended now streams too, instead of waiting for the next run to end.

- [#3374](https://github.com/langchain-ai/langgraphjs/pull/3374) [`abea7e8`](https://github.com/langchain-ai/langgraphjs/commit/abea7e8b42d1a9a38bb5a07c66228798e068f1d5) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` calls `onCreated` for each run a submit queued on the server, as the run starts streaming and after the run before it called `onRunEnd`. A submit made during a run never called `onCreated` before. A queued submit cancelled before its run started never does, and runs other clients queued don't, as before.

- [#3373](https://github.com/langchain-ai/langgraphjs/pull/3373) [`a9dc990`](https://github.com/langchain-ai/langgraphjs/commit/a9dc9907bad977259687dfa467d0e0fd6809d10f) Thanks [@eliornl](https://github.com/eliornl)! - A `stop()` right after a `submit()`, in the same tick, now stops it in `StreamOrchestrator` and the `useStream` hook from `@langchain/langgraph-sdk/react`. The stop came before the submit's stream began and was lost, so the run was created and streamed to the end. Now the stream begins stopped, so neither shows the input or sends anything. A `switchThread()` right after a submit drops it the same way, where `StreamOrchestrator` sent it to the new thread.
  
  `StreamOrchestrator` calls `onRunEnd` with `reason: "stopped"` and no `runId` for a submit stopped before its run's id came, so `runId` is optional in `onRunEnd`'s type.

- [#3371](https://github.com/langchain-ai/langgraphjs/pull/3371) [`09e4351`](https://github.com/langchain-ai/langgraphjs/commit/09e4351a78bed1487c245d0bf5a9b0693937151d) Thanks [@eliornl](https://github.com/eliornl)! - `CustomStreamOrchestrator` reports each run's lifecycle itself, as `StreamOrchestrator` does, so framework bindings don't have to work it out from its state:
  
  - `onCreated` gets the run id from the first `metadata` event of each run's stream. The option was accepted before and never called.
  - The new `onRunEnd` option gets `{ runId, reason }` when each run's stream ends, before its `submit()` resolves. The reason is `"interrupt"` when the stream sent an interrupt, `"error"` when it failed, also by timing out, `"stopped"` when it was aborted, as by `stop()` or a thread switch, and `"success"` otherwise. A run the engine's `dispose()` stops isn't reported.
  - An `onCreated` or `onRunEnd` that throws is logged, and affects neither the run nor the ones after it.
  - Switching to another thread calls `onThreadId`, through `switchThread()`, `syncThreadId()` or `hydrate()`. Before, only a submit that created a thread called it.
  - A run that fails or is stopped ends the subagents it left open with an error, as on an Agent Server, instead of leaving them running.

- [#3363](https://github.com/langchain-ai/langgraphjs/pull/3363) [`82a7d07`](https://github.com/langchain-ai/langgraphjs/commit/82a7d070eff81a653d2b292ef5e2ad8169e91555) Thanks [@eliornl](https://github.com/eliornl)! - A `StreamOrchestrator` that loads threads now needs `activate()`, which bindings call from an effect. A thread load before the first `activate()` reads the thread and holds what it finds until then: the running run's join, the head's headless tool calls and the server's queued runs. Bindings create the engine during a render, and an engine from a render that never commits, such as StrictMode's double render or a suspended tree that unmounts, used to join runs, run tools a second time and send their answers again. A running run a load holds counts as `isLoading`, so the queue waits for it too. A stream the engine starts before `activate()`, such as a submit from an effect that runs before the binding's, drops what the load held. `respond()` with no id now answers the first interrupt shown, as `CustomStreamOrchestrator` does. `StreamController`, which the Vue, Svelte and Angular bindings use, still answers the newest. The engine also reads the server's `/info` at its first `activate()` instead of when it's built, and warns about a server without subagent lifecycle events only once a subagent's messages are read.

- [#3356](https://github.com/langchain-ai/langgraphjs/pull/3356) [`6cf515f`](https://github.com/langchain-ai/langgraphjs/commit/6cf515ff63a29a90e8c3220b36c2727f1b0db856) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` shows the interrupts of a thread it loads only after the load has looked for a run still going on that thread, so they show a request or two later than before. When the load found a run in progress, that run's `{ when: "breakpoint" }` placeholder, or an interrupt it had already answered, showed until the join started. Headless tools waiting in the loaded state run after that lookup too, so a reload during a resumed tool run no longer runs the tool again. The lookup gives up after 10 seconds, and the reload after the thread watcher misses events waits the same way. `respond()` with no id waits for the lookup, and rejects if the thread closes or changes meanwhile. An interrupt already on screen stays shown while `hydrate()` reads the thread again, and a run started during a load shows its interrupts without waiting for the lookup.

- [#3168](https://github.com/langchain-ai/langgraphjs/pull/3168) [`99b9dde`](https://github.com/langchain-ai/langgraphjs/commit/99b9dde5a75cbbd3a2fa72c2014f38fbad053d1b) Thanks [@eliornl](https://github.com/eliornl)! - With `reconnectOnMount`, a `stop()` from `useStream` before the server has answered the run's request now cancels that run once its id arrives. The hook creates these runs with `on_disconnect: "continue"`, and only the response names the run, so the stop used to close the request and leave the run going on the server. The request now stays open for up to 5 seconds to learn the id, while the UI still stops at once.

- [#3378](https://github.com/langchain-ai/langgraphjs/pull/3378) [`e337917`](https://github.com/langchain-ai/langgraphjs/commit/e3379170d2bdea6b603949e83475f01024e7c3c3) Thanks [@eliornl](https://github.com/eliornl)! - A subagent rebuilt from a loaded thread's messages takes its namespace from its `task` tool message when the message records it (`artifact.checkpoint_ns`, which Python deepagents write), with no request. Before, its `namespace` stayed empty until something looked it up in the thread's history.
  
  A subagent the main agent called has `depth: 1` also before it runs and after a reload, where it had `0`. Once its events streamed, it already had `1`.

## 1.16.0

### Minor Changes

- [#3332](https://github.com/langchain-ai/langgraphjs/pull/3332) [`c3c2c56`](https://github.com/langchain-ai/langgraphjs/commit/c3c2c56b6b1eaaa2f2338cded1f2ff501169e646) Thanks [@eliornl](https://github.com/eliornl)! - New in `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`): subagent panels that stream only while they are open.
  
  - `scopes.acquire(namespace)` holds the scope of a subgraph, such as a subagent's panel, and returns `{ getSnapshot, subscribe, release }`. A snapshot has the subgraph's messages, as `BaseMessage` instances, and its latest values. All held scopes of a run share one join of it from its start, which the server filters to their namespaces when it can. A subagent no run is streaming is read once from the thread's history.
  - `scopedSubagents: true` streams each subagent only to its scopes and keeps its messages out of the main conversation, as `filterSubagentMessages` does. Runs then stream subgraphs, queued ones too, and on a server with the `stream_namespaces` and `stream_lifecycle` flags in `/info`, a run's own stream carries only the main conversation and the subagents' lifecycle events. A joined run does the same when it was created that way. It's off by default, since `subagents` then has a subagent's status and result but not its messages on such a server: they come from its scope.
  - `resolveSubagentNamespace(toolCallId)` finds a subagent's namespace after a reload, from its tool message or one small page of the thread's history.
  - Panel joins wait while four of the page's engine streams are open, so `stop()` and `respond()` keep a free connection on servers that speak only HTTP/1.1, such as `langgraph dev`.

- [#3331](https://github.com/langchain-ai/langgraphjs/pull/3331) [`7c28214`](https://github.com/langchain-ai/langgraphjs/commit/7c28214376f5bc7bb88903130e066f08dec7ea21) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) reads subagent and tool events:
  
  - With `filterSubagentMessages`, runs ask the server for `lifecycle` events, and with `onToolEvent`, for `tools` events, when the server sends them on run streams. It reads `/info` once per client to know. `onToolEvent` fires now: runs never asked for `tools` before. A server that refuses them with a 422, such as an older one during a rollout, gets the run again without them.
  - Each subagent is tied to the tool call that started it, from its `lifecycle` events or from the tool call id deepagents puts on a subagent's tokens, so subagents with the same task text no longer swap. A subagent whose graph fails shows the error at once. Subagents still open when the server says their run failed or was cancelled, or when `stop()` cancels it, end with an error. A run paused at an interrupt, a dropped connection or `stop({ cancel: false })` leaves them open.
  - `onChannelEvent(listener)` hands every event of its streams to the listener in `@langchain/react` 1.x's channel shape, `{ method, params: { namespace, timestamp, data } }`. `CustomStreamOrchestrator` has it too.
  
  In `StreamOrchestrator` and the `useStream` hook from `@langchain/langgraph-sdk/react`, when the server restarts a run (a worker stops, or a deploy outlasts the run), the main conversation drops what the cut attempt half-streamed and keeps what its finished steps wrote, instead of showing both. A subagent card that only the cut attempt's message started goes too.

- [#3324](https://github.com/langchain-ai/langgraphjs/pull/3324) [`f9bad09`](https://github.com/langchain-ai/langgraphjs/commit/f9bad0936380e2cabb9614ad3220bfe6f01ea98e) Thanks [@eliornl](https://github.com/eliornl)! - Add `client.info()`, which reads the server's version and the features it supports (`flags`) from `GET /info`. `client.runs.stream()` and `client.runs.joinStream()` take per-call reconnect options: `maxReconnectAttempts` (with `0`, a dropped stream throws instead of reconnecting), `reconnectDelayMs`, `onReconnect` (called with `attempt`, `cause`, `lastEventId` and `delayMs`) and `onConnected`. `client.threads.joinStream()` also sends its modes as one comma-joined `stream_modes`, the only form older servers read. The `Run` type has `kwargs`.

- [#3327](https://github.com/langchain-ai/langgraphjs/pull/3327) [`13c9590`](https://github.com/langchain-ai/langgraphjs/commit/13c9590a75bad3d0f653b22ec8dca5c344014d8d) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) now keeps a run going when its tab closes, and picks it up again:
  
  - Runs are created with `streamResumable` and `onDisconnect: "continue"`, and each thread load joins the thread's running run from the loaded checkpoint.
  - `stop()` stops the stream at once and cancels the run on the server, also a run it picked up after a load. A run whose id hasn't arrived yet is cancelled once it does. A run the app joins with `joinStream()` keeps going, and `stop({ cancel: false })` and `dispose()` leave any run going.
  - `durableRuns: false` keeps a run tied to its tab, as before this release.
  
  New options: `onRunEnd({ runId, reason })`, with `"success"`, `"error"`, `"interrupt"` or `"stopped"`, and `maxReconnectAttempts`, `reconnectDelayMs`, `onReconnect`, `onConnected` and `streamIdleReconnect`, passed to every run stream and join. New methods: `hydrate(threadId?)`, `hydrationPromise` and a StrictMode-safe `activate()`.
  
  A join of the run being submitted waits for its id, so the run doesn't stream twice, and a server-queued submit waits for that run to exist, so it can't overtake it. Runs it creates send `config.configurable.__event_streaming_v2: false`, so a thread a v3 client used streams the shape this engine reads, unless they send `context`, which the Agent Server doesn't take together with `configurable`.

- [#3340](https://github.com/langchain-ai/langgraphjs/pull/3340) [`bd2c46c`](https://github.com/langchain-ai/langgraphjs/commit/bd2c46c3a8167f1e71357ca59a26f9944d49ed44) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) now keeps metadata per message id in `messageMetadataStore`:
  
  - `parentCheckpointId` is the checkpoint to fork from to edit the message. Between `trackMessageMetadata()` and its release, the engine reads it from the thread's history whenever it is idle with messages it hasn't placed yet: after a load, and after each run back to the checkpoints it already read. It reads what each step wrote, about 1 KB a step, and the whole messages only for messages no step wrote, such as ones added with `updateState`. Messages more than about 500 steps back get none.
  - `optimisticStatus` is `pending` for an optimistic message until a `values` event of its run holds it, then `sent`. A run that fails or is stopped before that marks it `failed`, and one that succeeds or pauses marks it `sent`. A reload clears it.
  
  Every message a submit sends now carries an id, also with `optimistic: false` and for a run queued on the server. `MessageMetadataMap` and `OptimisticStatus` are exported.

- [#3328](https://github.com/langchain-ai/langgraphjs/pull/3328) [`737e53b`](https://github.com/langchain-ai/langgraphjs/commit/737e53b1d8f613e8844764b0f2f7c012e548a15c) Thanks [@eliornl](https://github.com/eliornl)! - New in `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`):
  
  - `respond(value, { interruptId? })` answers an interrupt, the newest one when no id is given, and `respondAll({ [interruptId]: value })` answers several in one run. Both take `update`, `goto`, `config`, `metadata` and `strictResume`. They ask for strict resume unless `strictResume` is `false`, so an answer to an interrupt that is no longer waiting fails its run instead of running the step again. During a run, the answer waits in the queue instead of interrupting it. An answered interrupt is hidden until its run ends, and shows again if the answer fails. The promise resolves once the run is created or queued.
  - A submit's input shows at once. Input messages without an id get one, so the run's copies replace them. Passing `optimisticValues` shows those instead, and `optimistic: false` turns this off.
  - `queue: "local"` keeps a submit made during a run on the client and sends it once the run ends, instead of queueing it on the server.
  - Interrupts carry the `namespace` they were raised in.
  
  A submit with `multitaskStrategy: "interrupt"` or `"rollback"` during a run now replaces that run's stream at once, as `useStream` does, instead of waiting for it to end. A submit queued behind a run now sends its `strictResume` too.

- [#3339](https://github.com/langchain-ai/langgraphjs/pull/3339) [`eb174a8`](https://github.com/langchain-ai/langgraphjs/commit/eb174a85b006c3b71626c9fb1edd2b4fdbd2cbbe) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) now follows its thread between `activate()` and dispose:
  
  - A run started elsewhere, such as in another tab or by a cron, is joined and streams here. A run that ended elsewhere reads the thread again, and an interrupt answered elsewhere is hidden at once.
  - It keeps one connection to the thread's `lifecycle` stream, closed while a run streams here, while the queue holds runs and while the page is hidden, and it resumes from the last event it saw. On a server without a thread stream it stays off after one request.
  - `watchThread: false` turns it off.
  
  Each thread load also lists the thread's queued runs, so a run queued before a reload shows in the queue again and streams when its turn comes. Since another client may have queued them, a thread switch leaves them on the server, while `cancelQueueItem()` and `clearQueue()` still cancel them. The queue now also moves on when a joined run ends.

- [#3349](https://github.com/langchain-ai/langgraphjs/pull/3349) [`c8a9c7d`](https://github.com/langchain-ai/langgraphjs/commit/c8a9c7de5f2c57362094815ab3024e133834ee91) Thanks [@eliornl](https://github.com/eliornl)! - `@langchain/langgraph-sdk/ui` now exports:
  
  - `SubgraphDiscovery`, with its `SubgraphDiscoverySnapshot`, `SubgraphMap` and `SubgraphByNodeMap` types. Its `push()` takes any event with a `method`, `params.namespace` and `params.data`, such as the ones `StreamOrchestrator.onChannelEvent` gives.
  - `seedToolCallsFromMessages`, which builds `AssembledToolCall`s from messages, and the `AssembledToolCall` and `ToolCallStatus` types.
  - `AssembledToolCallFromTool`, and `InferAssembledToolCalls`, which `@langchain/langgraph-sdk/stream` exports as `InferToolCalls`. The `InferToolCalls` that `./ui` already exports infers message tool calls and is unchanged.
  
  `@langchain/langgraph-sdk/stream` exports the same names and types as before.

### Patch Changes

- [#3252](https://github.com/langchain-ai/langgraphjs/pull/3252) [`3f15c7c`](https://github.com/langchain-ai/langgraphjs/commit/3f15c7cddf8832c841cdbd0db74f7218f747f1cf) Thanks [@richardscarrott](https://github.com/richardscarrott)! - After a reload, `useStream` now requests only checkpoints and tasks from `/history` to match subagents to their cards. The Python Agent Server 0.17.0 and later then leaves out the thread's values, so on a 20-turn thread the response drops from 55 MB to 298 KB. Subagent cards also no longer show another subagent's messages, or none, when another tool call in the same AIMessage was answered before the subagents started, for example one a human rejected. JS graphs need `@langchain/langgraph` 1.7.2 or later for that case. On older versions, unfinished subagents from that step show no messages after a reload.

- [#3350](https://github.com/langchain-ai/langgraphjs/pull/3350) [`c354854`](https://github.com/langchain-ai/langgraphjs/commit/c354854a9afd835837dad53d8443be944e9c400a) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) handles four cases the way `@langchain/react` 1.x apps expect:
  
  - A thread switch no longer shows the last thread's messages, error or selected branch while the new thread loads. `values` falls back to `initialValues`, and `isThreadLoading` is `true` until the read lands.
  - A thread id that doesn't exist yet, such as one minted in the browser for a new chat, loads as an empty thread with no error, and the first submit on it creates it with `POST /threads` and that id before its run, so the app's `threads.create` auth handler runs. A submit made while the thread loads waits for the load. A link to a deleted thread shows it empty, and its first submit creates it again. A thread that exists by the time of that create, such as one another tab created, is used as it is when the user's auth can read it, and refused otherwise.
  - A tool call whose tool message has `status: "error"` reads as failed, with the message's text as `error`, instead of finished. This applies to `@langchain/react` 1.x too: after a reload, and when a tool returns an error message of its own, which the `tools` channel reports as finished.
  - `resolveSubagentNamespace(toolCallId)` shares one lookup between callers that ask for the same subagent at the same time, so the hooks of one subagent panel read the thread's history once after a reload.

- [#3317](https://github.com/langchain-ai/langgraphjs/pull/3317) [`6aec378`](https://github.com/langchain-ai/langgraphjs/commit/6aec378fdc74450f225482f61d865ad0951ce082) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator.joinStream(runId)` now does nothing when `runId` is the run it is already streaming (from `submit()` or an earlier join, including the one `reconnectOnMount` starts) or has queued, and returns that stream's promise. Previously the second join waited for the current stream to end and then replayed the whole run, with a second loading phase and another history read. A run whose stream `stop()` or a thread switch cut off can still be joined again right away.

- [#3351](https://github.com/langchain-ai/langgraphjs/pull/3351) [`bbbc710`](https://github.com/langchain-ai/langgraphjs/commit/bbbc710910925151c9764e0041b5ef16490073b1) Thanks [@eliornl](https://github.com/eliornl)! - In `StreamOrchestrator` (`@langchain/langgraph-sdk/ui`), a new thread's first message shows as soon as it is submitted, as in `@langchain/react` 1.x. It showed only once `POST /threads` had created the thread. A new thread's create that fails no longer leaves an unhandled promise rejection, and a submit made meanwhile creates a thread itself instead of rejecting.

- [#3316](https://github.com/langchain-ai/langgraphjs/pull/3316) [`1adb1ec`](https://github.com/langchain-ai/langgraphjs/commit/1adb1ec6f6ae9ec7e4a7e66131309007211c2992) Thanks [@eliornl](https://github.com/eliornl)! - `StreamOrchestrator.submit()` with `multitaskStrategy: "reject"` while another run is streaming now sends `"reject"` to the server instead of queuing the run, so the server's rejection reaches `onError`. Submits with no strategy are still queued.

- [#3063](https://github.com/langchain-ai/langgraphjs/pull/3063) [`679a50f`](https://github.com/langchain-ai/langgraphjs/commit/679a50ff435cd1deb8482415c60d3a86e1e66f3a) Thanks [@sera-wi](https://github.com/sera-wi)! - Runs that `StreamOrchestrator.submit()` queues while another run is streaming now request the same stream modes as a direct submit. Previously the queued run was created without `streamMode`, so the server only produced `values` events for it: once the queue drained, replies arrived in one piece instead of token by token, and `updates`, `custom`, tool and message-tuple consumers received nothing.

- [#3326](https://github.com/langchain-ai/langgraphjs/pull/3326) [`75297cb`](https://github.com/langchain-ai/langgraphjs/commit/75297cbffc1eeb95ec183d82decf7c3f324cc54d) Thanks [@eliornl](https://github.com/eliornl)! - Resumable run streams and joins reconnect when the server sends no readable `Location` header, as with the JS dev server or a CORS config that doesn't expose it. For a resumable run, `client.runs.stream()` rebuilds the reconnect path from the run's `Content-Location`, threadless runs included, or from its thread and run id, and `client.runs.joinStream()` reconnects to its own URL. When `Content-Location` is hidden too, `onRunCreated` fires with the run id from the run's `metadata` event. Aborting a stream during the wait before a reconnect now ends it at once, not after the wait.

- [#3330](https://github.com/langchain-ai/langgraphjs/pull/3330) [`e2e196e`](https://github.com/langchain-ai/langgraphjs/commit/e2e196e9122bd56abfa2279c93763453da6e8b76) Thanks [@eliornl](https://github.com/eliornl)! - `client.runs.stream()` and `client.runs.joinStream()` called with `streamNamespaces` now drop the events outside those namespaces themselves, by the same rule as the Agent Server. A server that doesn't support the filter (an older version, or the JS dev server) sent every event before, and now gives the same events as one that does. `onToolEvent` no longer gets tool events of kinds other than `on_tool_start`, `on_tool_event`, `on_tool_end` and `on_tool_error`, which older queue workers forward for Python graphs.

- [#3320](https://github.com/langchain-ai/langgraphjs/pull/3320) [`d685e95`](https://github.com/langchain-ai/langgraphjs/commit/d685e95fbd025de69d7a51bce5b45e7ead724b61) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): `useStream` from `@langchain/langgraph-sdk/react` now calls the `onError` passed to `submit()` when that run fails, after the hook's own `onError`. It was typed and documented but never called, on both the LangGraph server and the custom `transport` paths.

## 1.15.0

### Minor Changes

- [#3186](https://github.com/langchain-ai/langgraphjs/pull/3186) [`e76a53e`](https://github.com/langchain-ai/langgraphjs/commit/e76a53e7a2c659ff3f63bc26ebb054338968e2ba) Thanks [@eliornl](https://github.com/eliornl)! - `client.runs.joinStream` takes a `checkpointId` option, sent as the `checkpoint_id` query parameter: servers that support it send only the run's events after that checkpoint, or the whole run when it is not one of the run's, and other servers ignore it. With `reconnectOnMount`, the `useStream` hook now rejoins a running run once the thread state has loaded, from the loaded head's checkpoint, so a reload no longer replays the run from its start over the state it just loaded. A streamed message now updates the message with its id wherever it is in the list, so one the loaded state already holds, or one a `values` event moved, is not appended again or written over another. `MessageTupleManager.get`'s `defaultIndex` argument and the `index` field of its entries are deprecated: `StreamManager` no longer reads them, and they will be removed in 2.0.

### Patch Changes

- [#3263](https://github.com/langchain-ai/langgraphjs/pull/3263) [`0398106`](https://github.com/langchain-ai/langgraphjs/commit/03981062e9010b7454b8e9e290455d9d96306db9) Thanks [@eliornl](https://github.com/eliornl)! - After `submit(input, { forkFrom })`, `messages` shows only the new branch. A fork's checkpoints restart at a lower step, so they were treated as an old replay and merged add-only, which kept every message from the abandoned branch until a reload. Also, `useMessageMetadata(...).parentCheckpointId` now keeps the parent of the first checkpoint that carried each message, instead of moving every message to the latest checkpoint's parent, so forking from it edits the right message.

- [#3260](https://github.com/langchain-ai/langgraphjs/pull/3260) [`5e70fcf`](https://github.com/langchain-ai/langgraphjs/commit/5e70fcf1dcde1d173513139ee3e3eece14d57a95) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): a `hydrate()` of the thread already shown no longer leaves `isLoading` stuck on `true` after the run ends: when it reopens the thread's stream after the connection dropped, when the run ends while it reads the state, or when it finds a run on a thread that was idle. When it finds a run going, the messages it loaded stay on screen while the stream replays the run. The stream also picks up interrupts raised inside subagents again after it reconnects.

- [#3261](https://github.com/langchain-ai/langgraphjs/pull/3261) [`dcbe966`](https://github.com/langchain-ai/langgraphjs/commit/dcbe966ed9a8487806d3ce6afd93b986611499b5) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): `stop()` cancels the run `respond()` or `respondAll()` started, also when it is called before that run starts, and shows again the interrupts the cancel left waiting.

- [#3261](https://github.com/langchain-ai/langgraphjs/pull/3261) [`dcbe966`](https://github.com/langchain-ai/langgraphjs/commit/dcbe966ed9a8487806d3ce6afd93b986611499b5) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): `submit()` without a `multitaskStrategy`, while the thread shows a run in flight, now sends `interrupt`, so the server cancels the run the client stopped following instead of queueing the new one behind it. Otherwise it still sends only a strategy the caller passed.

## 1.14.0

### Minor Changes

- [#3230](https://github.com/langchain-ai/langgraphjs/pull/3230) [`fe93dbe`](https://github.com/langchain-ai/langgraphjs/commit/fe93dbed0ea371a0a9b6c7fdf33fa458ff1900fa) Thanks [@eliornl](https://github.com/eliornl)! - feat(sdk): hide the interrupts another client answered when the server sends `input.answered`, and route that event to the `input` channel

- [#3230](https://github.com/langchain-ai/langgraphjs/pull/3230) [`fe93dbe`](https://github.com/langchain-ai/langgraphjs/commit/fe93dbed0ea371a0a9b6c7fdf33fa458ff1900fa) Thanks [@eliornl](https://github.com/eliornl)! - feat(sdk): add `strictResume`, so a server with strict resume refuses an answer to an interrupt that is no longer waiting. `client.runs.create()`, `stream()` and `wait()` send it as `strict_resume`, and `useStream`'s `submit()` passes it on. With `respond()` and `respondAll()`, the refusal is an `UnknownInterruptError` on `error` with `reason`, `interruptIds` and `pendingIds`, which `isUnknownInterruptError(error)` recognizes, and the interrupts still waiting show again.

### Patch Changes

- [#3243](https://github.com/langchain-ai/langgraphjs/pull/3243) [`c7861c1`](https://github.com/langchain-ai/langgraphjs/commit/c7861c127acf981a01b1745690018f942e1226ba) Thanks [@eliornl](https://github.com/eliornl)! - `useStream` ignores a `tools` event of a kind it doesn't know, such as langgraph's own `tool-started` payload, instead of throwing `Unexpected tool event` inside a state update, which crashed the app's render.

- [#3247](https://github.com/langchain-ai/langgraphjs/pull/3247) [`95ce066`](https://github.com/langchain-ai/langgraphjs/commit/95ce066af5a71c7ad114ccc538fd02dae300561a) Thanks [@eliornl](https://github.com/eliornl)! - chore: depend on @langchain/protocol 0.0.21, which types `input.answered`, and map `input.answered` to the `input` channel in `inferChannel`. `input` subscribers now get `input.answered` as well as `input.requested`, so code that reads `data.interrupt_id` should check `event.method` first.

- [#3228](https://github.com/langchain-ai/langgraphjs/pull/3228) [`ebf99fe`](https://github.com/langchain-ai/langgraphjs/commit/ebf99fe6a403cb119d36d117cfc82b9111c8111b) Thanks [@eliornl](https://github.com/eliornl)! - Run streams take the `lifecycle` stream mode, typed as `LifecycleStreamEvent`: an event when each subgraph starts and ends, with the id of the tool call that started it.

- [#3246](https://github.com/langchain-ai/langgraphjs/pull/3246) [`5d1ceb0`](https://github.com/langchain-ai/langgraphjs/commit/5d1ceb0016cf8a5304c75554c99d3d79f81470ac) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): `run.start` sends the multitask strategy as `multitask_strategy`, like the protocol's other fields, as well as `multitaskStrategy`, which older servers read.

## 1.13.0

### Minor Changes

- [#3209](https://github.com/langchain-ai/langgraphjs/pull/3209) [`7209193`](https://github.com/langchain-ai/langgraphjs/commit/7209193a2b7f5f9275780953d92ebc454c8550d4) Thanks [@eliornl](https://github.com/eliornl)! - `client.runs.stream` and `client.runs.joinStream` take `streamNamespaces`, the namespaces of a run to stream (`""` is the root graph), each without the subagents it starts. Servers that support it report `stream_namespaces` in `/info`; older servers ignore it and send every event. A reconnect no longer re-sends query params its `Location` already carries, so the URL stops growing on every reconnect.

### Patch Changes

- [#3223](https://github.com/langchain-ai/langgraphjs/pull/3223) [`caa5c53`](https://github.com/langchain-ai/langgraphjs/commit/caa5c53a65b0d0cce2a597167087f1bf9b170437) Thanks [@casparb](https://github.com/casparb)! - Add a `reason` option to `client.runs.cancel`. Set `reason: "taken"` to mark run input absorbed for steering; the server records a `cancel_reason` starting with `taken:`.

- [#3219](https://github.com/langchain-ai/langgraphjs/pull/3219) [`75deb9a`](https://github.com/langchain-ai/langgraphjs/commit/75deb9a65b7e3254429ec193db35953b69ad605c) Thanks [@eliornl](https://github.com/eliornl)! - Type the `end` event that closes a run stream as `EndStreamEvent`: its data carries the run's `run_id` and final `status`, or is `null` from servers that send it without data.

- [#3191](https://github.com/langchain-ai/langgraphjs/pull/3191) [`5ef8ba8`](https://github.com/langchain-ai/langgraphjs/commit/5ef8ba8cad1b3638d9f0bba2f2db58db7dcfaa33) Thanks [@eliornl](https://github.com/eliornl)! - When the `threadId` option of `useStream` changes while the last run's values still hold a pending headless tool call, the hook no longer runs that tool again. It also no longer resumes the new thread, or a thread it creates after a switch to `null`, with the previous thread's interrupt id. Passing back the `threadId` of a thread `submit` created no longer runs its pending tool again either.

- [#3208](https://github.com/langchain-ai/langgraphjs/pull/3208) [`08f6d06`](https://github.com/langchain-ai/langgraphjs/commit/08f6d069af8a51f913a63990bec31f0fe985b5f7) Thanks [@casparb](https://github.com/casparb)! - The client no longer sends a `POST` or `PATCH` request again after it may have reached the server, so a retry can no longer create a second run or repeat a protocol command. These requests are now retried only when the connection failed before they were sent (for example, the connection was refused or the host was not found). `GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` requests are retried as before.

- [#3206](https://github.com/langchain-ai/langgraphjs/pull/3206) [`d955450`](https://github.com/langchain-ai/langgraphjs/commit/d9554503a7ccef99f46474831ec93ed1c527ca57) Thanks [@casparb](https://github.com/casparb)! - Add `cancel_reason` to the `Run` type and to `RunSelectField`. The Agent Server returns why a run was cancelled, but callers had to cast to read it.

- [#3204](https://github.com/langchain-ai/langgraphjs/pull/3204) [`2f42fb1`](https://github.com/langchain-ai/langgraphjs/commit/2f42fb196d840931f11a4da114f030f3ba4a90fe) Thanks [@sera-wi](https://github.com/sera-wi)! - `ThreadsClient.getState` and `ThreadsClient.getHistory` accept a `select` option to return only some fields, e.g. `select: ["values.messages"]` to read a single state key. Exports the new `ThreadStateSelectField` type and the existing `ThreadSelectField` type from the package root.

## 1.12.10

### Patch Changes

- [#3163](https://github.com/langchain-ai/langgraphjs/pull/3163) [`2f7b082`](https://github.com/langchain-ai/langgraphjs/commit/2f7b082df1fdf18122e41dead7cce7cda3c7fb6a) Thanks [@eliornl](https://github.com/eliornl)! - When a headless tool finishes after a switch to another thread, `StreamOrchestrator` no longer sends its result to the new thread, keyed by the previous thread's interrupt id, and the `useStream` hook no longer streams the previous thread's resumed run into the new thread's view and no longer aborts a run the new thread is streaming. The call stays pending on its own thread and runs again when that thread is shown.

- [#3185](https://github.com/langchain-ai/langgraphjs/pull/3185) [`60bf21d`](https://github.com/langchain-ai/langgraphjs/commit/60bf21d7ab897a94d652a0258df6896b3ed0bfdb) Thanks [@eliornl](https://github.com/eliornl)! - A thread run stream from `client.runs.stream()` or `client.runs.joinStream()` that ends without an error and without an `end` or `error` event now asks the server for the run's status. If the run is still pending or running, for example because a proxy timeout or a server restart ended the response, the stream reconnects from the last event as it does after a dropped connection, instead of ending early with a cut answer. A 429, a 5xx or a network error on that check is handled like a dropped connection too. This adds one request at the end of such a stream.

## 1.12.9

### Patch Changes

- [#3128](https://github.com/langchain-ai/langgraphjs/pull/3128) [`e0109cb`](https://github.com/langchain-ai/langgraphjs/commit/e0109cb5711f42c8c4986a61967d2a7634a4ef0a) Thanks [@hntrl](https://github.com/hntrl)! - Fix SSE multiline JSON framing, colonless fields, stream-leading BOM handling, and empty event ID resets during reconnection. Match Python streaming behavior: empty payloads yield null, events inherit the reconnect cursor, and ID-only/retry-only blocks update internal state without being yielded to callers. Cleared event IDs are exposed as undefined. Pending unnamed data is flushed at EOF, matching Python's existing tolerant EOF behavior.

- [#3123](https://github.com/langchain-ai/langgraphjs/pull/3123) [`b5f96bd`](https://github.com/langchain-ai/langgraphjs/commit/b5f96bdac43542a053a80cb4b056d710cf46393c) Thanks [@eliornl](https://github.com/eliornl)! - A run abandoned by `clear()` or `stop()` no longer runs `onSuccess`, so a thread switch during a reconnect backoff no longer loads the previous thread's history.

- [#3158](https://github.com/langchain-ai/langgraphjs/pull/3158) [`3aa46f1`](https://github.com/langchain-ai/langgraphjs/commit/3aa46f1075a7a2975461dc4b42f86867def9a139) Thanks [@eliornl](https://github.com/eliornl)! - A headless tool call still waiting for its result when a thread opens, for example after a page reload, now runs once and resumes the run in the `useStream` hook and `StreamOrchestrator`; before, nothing ran and the thread stayed paused. Effects replayed by StrictMode, Fast Refresh or `<Activity>` no longer run a pending headless tool twice in the hook, nor, under Fast Refresh or `<Activity>`, with a custom `transport`.

- [#3139](https://github.com/langchain-ai/langgraphjs/pull/3139) [`a181b4d`](https://github.com/langchain-ai/langgraphjs/commit/a181b4d95501a41b949e1f9f1dea9ed055a50147) Thanks [@eliornl](https://github.com/eliornl)! - With history enabled, `joinStream` in the `useStream` hook and `StreamOrchestrator` now shows the thread state read after the joined run ends, as `submit` already does, instead of the joined stream's last values.

- [#3153](https://github.com/langchain-ai/langgraphjs/pull/3153) [`5e7fa49`](https://github.com/langchain-ai/langgraphjs/commit/5e7fa49a0c3bfa3c68aff4e982483f098062ba8e) Thanks [@eliornl](https://github.com/eliornl)! - Joining a run from its first event in a mount that already streamed it no longer doubles each message's text, subagent messages included. A join that resumes from a `lastEventId` still continues the message where it left off.

- [#3159](https://github.com/langchain-ai/langgraphjs/pull/3159) [`204fc6f`](https://github.com/langchain-ai/langgraphjs/commit/204fc6fa7c5d6c427a2a85f6ec5c6219afac5efc) Thanks [@eliornl](https://github.com/eliornl)! - With history enabled, `submit` in the `useStream` hook and `StreamOrchestrator` no longer pins the run to the cached head of the shown branch when the latest branch is shown, so turns added elsewhere since the history was read (another tab, a cron, an API call, or this tab's own earlier run when a second submit was queued behind it) stay on the shown branch instead of moving to a sibling branch. A shown branch whose head is not the newest loaded checkpoint still forks from that head.

- [#3140](https://github.com/langchain-ai/langgraphjs/pull/3140) [`918f958`](https://github.com/langchain-ai/langgraphjs/commit/918f958768c69d952769fcb979844490b7b40ded) Thanks [@eliornl](https://github.com/eliornl)! - Without history, the `useStream` hook and `StreamOrchestrator` now read the thread again after a run that succeeds when the state shown had an interrupt, a node still to run or a task error, so an answered approval no longer comes back and an old error goes away. A run on a thread that showed none of these makes no extra request, and a failed read reports no error. With history, a failed read after a run no longer fails the run in the hook or skips `onFinish` in `StreamOrchestrator`.

- [#3152](https://github.com/langchain-ai/langgraphjs/pull/3152) [`3c632fa`](https://github.com/langchain-ai/langgraphjs/commit/3c632fa2aa2d7e35f2540f556d8318f157ebe306) Thanks [@eliornl](https://github.com/eliornl)! - A stream that reconnects now gets a fresh set of reconnect attempts each time an event arrives, as the Python SDK does, so a long stream no longer gives up at its sixth drop when every reconnect worked. A frame with only an `id:` or a `retry:` field does not count as an event.

- [#3124](https://github.com/langchain-ai/langgraphjs/pull/3124) [`a73261d`](https://github.com/langchain-ai/langgraphjs/commit/a73261dd575f4a8a84058a241cd60ccabdb08ccf) Thanks [@eliornl](https://github.com/eliornl)! - `stop()` in the `useStream` hook and `StreamOrchestrator` no longer loses the session. Without history and without an `onFinish` that takes the thread state, stopping a running stream put back the thread state read when the thread opened, so the turns sent since disappeared and `onStop` edits were overwritten. A stop now reads the thread and shows what the server kept, with the `onStop` edits applied on top. With or without history, a stop no longer shows the cancellation as an error, or the node it cut off as a breakpoint.

- [#3123](https://github.com/langchain-ai/langgraphjs/pull/3123) [`b5f96bd`](https://github.com/langchain-ai/langgraphjs/commit/b5f96bdac43542a053a80cb4b056d710cf46393c) Thanks [@eliornl](https://github.com/eliornl)! - After a reload, a subagent delegated by an older turn is no longer shown with the tool results of a newer turn.

- [#3123](https://github.com/langchain-ai/langgraphjs/pull/3123) [`b5f96bd`](https://github.com/langchain-ai/langgraphjs/commit/b5f96bdac43542a053a80cb4b056d710cf46393c) Thanks [@eliornl](https://github.com/eliornl)! - After a reload, a subagent that is still running or waiting on an approval no longer shows the state of a regular tool called before it in the same message.

- [#3123](https://github.com/langchain-ai/langgraphjs/pull/3123) [`b5f96bd`](https://github.com/langchain-ai/langgraphjs/commit/b5f96bdac43542a053a80cb4b056d710cf46393c) Thanks [@eliornl](https://github.com/eliornl)! - With `streamSubgraphs`, values from a subgraph that is not a subagent no longer replace the root state while the subgraph runs. Its results show once its node returns.

- [#3123](https://github.com/langchain-ai/langgraphjs/pull/3123) [`b5f96bd`](https://github.com/langchain-ai/langgraphjs/commit/b5f96bdac43542a053a80cb4b056d710cf46393c) Thanks [@eliornl](https://github.com/eliornl)! - A numeric `throttle` notifies at most once per interval while values keep changing, as documented, instead of waiting until they stop.

- [#3137](https://github.com/langchain-ai/langgraphjs/pull/3137) [`2965bc1`](https://github.com/langchain-ai/langgraphjs/commit/2965bc1083945c16f38cdc9ef427991d7af11ff6) Thanks [@richardscarrott](https://github.com/richardscarrott)! - fix(sdk): re-parse streamed tool call args at most every 50ms instead of on every chunk
  
  The `useStream` hook from `@langchain/langgraph-sdk/react` re-parsed a streaming tool call's full arguments on every `messages` chunk, so the work grew quadratically with the length of the arguments. It now reuses the previous parse and re-parses at most every 50ms, and once more when the stream ends. Subagent messages get the same treatment.
  
  The `@langchain/core` peer dependency is raised from `^1.1.48` to `^1.2.18`, the first release that parses tool call chunks lazily. Older releases parse them on every chunk regardless, so they would get the delay without the speedup.

## 1.12.8

### Patch Changes

- [#3096](https://github.com/langchain-ai/langgraphjs/pull/3096) [`f3dfbb2`](https://github.com/langchain-ai/langgraphjs/commit/f3dfbb2c3f6c4ff5d30aceca027ab19fca021bde) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): stop retrying cancelled requests, release abort listeners and emit CR-terminated SSE lines at once
  
  - A request cancelled with an `AbortSignal` or `timeoutMs` is no longer retried. Native `AbortError` and `TimeoutError` exceptions were retried with backoff, so calling `stop()` before the server answered kept `isLoading` on for 15 to 30 seconds.
  - A request with a timeout no longer leaves an abort listener on the caller's signal, so reusing one signal for many requests stops piling up listeners. Runtimes without `AbortSignal.any` (Safari before 17.4, Node before 20.3) still hold one listener per request until its timeout fires or it is cancelled.
  - The SSE decoder emits a line ending in a bare CR as soon as it arrives instead of holding it until the next chunk, and no longer drops the blank line of a stream that ends with CR.

## 1.12.7

### Patch Changes

- [#3060](https://github.com/langchain-ai/langgraphjs/pull/3060) [`2b982b6`](https://github.com/langchain-ai/langgraphjs/commit/2b982b6cb4fbdf1493a40994660b1c7df97963aa) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): stop resolved interrupts from coming back after a reload
  
  After a reload, the first submit or respond on the Agent Server brought back every interrupt the thread had already resolved, and accepting them failed with `no_such_interrupt`. Its HTTP commands report `applied_through_seq: 0`, so the SDK treated the whole replayed history as new. When a command reports 0, the SDK now finds where the command's run starts on the thread stream and treats everything before it as history.

## 1.12.6

### Patch Changes

- [#3022](https://github.com/langchain-ai/langgraphjs/pull/3022) [`a17f609`](https://github.com/langchain-ai/langgraphjs/commit/a17f6098a853d1051c810f2c8dffa15e4de8f083) Thanks [@richardscarrott](https://github.com/richardscarrott)! - Tool-call args streamed as `tool-call-delta` slices are appended to the tool call, so `useStream`, scoped `useMessages`, `thread.messages`, `subgraph.messages` and `subagent.messages` show live args whether the server sends slices or the older `block-delta` snapshots. `block-delta` still replaces the args.
  
  Delta variants the SDK doesn't recognise are now ignored. Before, one froze a scoped `useMessages` view until the run ended, left the in-flight `thread.messages` message unsettled, and crashed Node with an unhandled rejection from `subgraph.messages` or `subagent.messages`. `MessageAssembler.consume` returns `undefined` for such events.
  
  Upgrade the SDK and its bindings before your server emits `tool-call-delta`.

## 1.12.5

### Patch Changes

- [#2962](https://github.com/langchain-ai/langgraphjs/pull/2962) [`2e1fe5b`](https://github.com/langchain-ai/langgraphjs/commit/2e1fe5b3fffd87b2f7ba260da3726a2c03c2f72f) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): a reply cut off mid-stream, for example by `stop()`, no longer lingers in `useStream` messages after its run ends: it is dropped as soon as the run ends, stays gone after a page refresh, and is dropped in other tabs watching the thread too. A reply that finished streaming before the run paused for input stays visible while paused and is replaced, not duplicated, when the run resumes. Streaming message handles for a cut-off message now settle with an `aborted` error instead of never resolving.

- [#3024](https://github.com/langchain-ai/langgraphjs/pull/3024) [`0acf88d`](https://github.com/langchain-ai/langgraphjs/commit/0acf88db9fdc6441c8b3a162b7a328b9b91e115e) Thanks [@eliornl](https://github.com/eliornl)! - Opening a thread with recent activity no longer replays it in `useStream`. Every new stream subscription receives the thread's recent events again, and the controller applied them on top of the state it had just loaded, so `messages`, `values` and `toolCalls` rewound to earlier turns and rebuilt themselves while old tool calls flashed through running and finished. The controller now skips events produced before the checkpoint it loaded. Scoped views, such as `useMessages` on a subagent, still receive the full history.
  
  A `submit()` sent right after opening a thread also no longer ends early. A replayed completion from an earlier run used to settle it, clear `isLoading` and fire `onCompleted` while the new run was still going.

- [#3023](https://github.com/langchain-ai/langgraphjs/pull/3023) [`9cc54cc`](https://github.com/langchain-ai/langgraphjs/commit/9cc54cce575ae00deb0bb5946aa457f44f485427) Thanks [@eliornl](https://github.com/eliornl)! - `messagesProjection([])`, the root-namespace messages projection acquired through `StreamController.registry`, now fills from the root event stream. It threw a `ReferenceError` on every event and stayed empty. The framework hooks were not affected: `useMessages` returns `stream.messages` for the root.

- [#3031](https://github.com/langchain-ai/langgraphjs/pull/3031) [`4690a5b`](https://github.com/langchain-ai/langgraphjs/commit/4690a5b9a59f4f96790fdce45160f744272ca054) Thanks [@eliornl](https://github.com/eliornl)! - Stop the protocol WebSocket transport from reconnecting when the server closes the socket with 4000 plus a 4xx status (4403, 4404, 4422 and the like; 4408 and 4429 still reconnect): the event stream now ends at once with an error that carries the `status`. Other 4xxx closes still reconnect, with the `status` on the `onReconnect` cause. A WebSocket thread stream that fails for good now reaches `ThreadStream.onError`, so `useStream` sets `error` and clears `isLoading`, as it already did for SSE. A command whose send fails no longer leaves a response promise behind to be rejected later as an unhandled rejection.

## 1.12.4

### Patch Changes

- [#2961](https://github.com/langchain-ai/langgraphjs/pull/2961) [`1631fd8`](https://github.com/langchain-ai/langgraphjs/commit/1631fd895723c4553345ceb5d9fc425b68bda959) Thanks [@soarez](https://github.com/soarez)! - order parallel writes by task path, like langgraph (Python) — one sort key for live execution and every saver, instead of the task-id order [#2544](https://github.com/langchain-ai/langgraphjs/issues/2544) added for DeltaChannel writes
  
  When two or more tasks in one superstep write the same `DeltaChannel`, their writes are now applied and replayed in `(task_path, task_id, idx)` order — the order Python's langgraph#8544 established — instead of task-id order. Task ids are uuid5 hashes that include the checkpoint id, so the old order permuted parallel writers from run to run and disagreed with Python.
  
  - `BaseCheckpointSaver.putWrites` takes an optional `taskPath` (the serialized task path, `taskPathStr`), and `getTuple`/`list` must return `pendingWrites` in the new `writesSortKey` order. `writesSortKey` and `compareWritesSortKeys` are new exports of `@langchain/langgraph-checkpoint`; every saver (memory, SQLite, Postgres, Redis incl. ShallowRedisSaver, MongoDB) stores the path and sorts in JS — no database collation is involved.
  - SQLite and Postgres gain a `task_path` column (migrated automatically on `setup()`; read-only pre-column SQLite databases keep reading, with their rows keeping the old order). Redis and MongoDB documents gain a `task_path` field. Rows written before the upgrade keep their old order.
  - Exit-durability resumes replay delta writes in live order (port of langgraph#9114): the resumed superstep's writes interleave with the loaded ones by task path, later supersteps sort after every real write, and writes loaded with the checkpoint are no longer stored twice.
  - `bulkUpdateState` seals the first update superstep: DeltaChannels touched by the base checkpoint's pending writes (and whose version moved) snapshot on the update checkpoint, so a finished sibling's writes and the update's can't replay in the wrong order (partial port of langgraph#8548).
  - `bulkUpdateState`/`updateState` update tasks carry `(__interrupt__, i)` task paths, as in langgraph#9128, so several updates in one superstep writing the same DeltaChannel replay in the order given.
  - Send task paths become `[PUSH, i, false]` and node-error-handler paths become `[*failedTask.path[:3], "node_error_handler", false]` (the failed task's first three path elements), matching Python's shapes — `langgraph_path` task metadata changes accordingly, and task ids of functional `task()` calls under a Send or handler task change with them. The SDK's Send-task detection accepts both the old and new shapes.
  
  Upgrade notes:
  
  - `PostgresSaver`: run `setup()` once after upgrading, from one process, before the new version serves traffic. The `task_path` column comes from the first new migration since the saver shipped, and until it runs, reads and writes fail with `column "task_path" does not exist`. Several processes running `setup()` at once on a database that still needs the migration can fail with a duplicate key error on `checkpoint_migrations`.
  - Third-party checkpoint savers remain source-compatible but must now persist the `taskPath` they are given and return `pendingWrites` in `writesSortKey` order; the conformance suite's new base tests enforce this. A saver that ignores the new argument replays in task-id order and can rebuild a different DeltaChannel value than the run produced.
  - An incomplete superstep containing stored delta writes that must interleave with resumed or retried task writes is affected by the upgrade, whether the incompleteness came from an interrupt, a task error, a crash, or a drain: finish such threads with the old runtime before upgrading writers. A single interrupted node with no finished delta-writing siblings is safe to resume. The same applies to resuming work that includes functional `task()` calls under a Send or error-handler task, whose child task ids change.
  - `@langchain/langgraph-checkpoint` 1.2.0 must be released before any package requiring its new exports; the consumers' minimum ranges are raised accordingly.

## 1.12.3

### Patch Changes

- [#2956](https://github.com/langchain-ai/langgraphjs/pull/2956) [`218ea20`](https://github.com/langchain-ai/langgraphjs/commit/218ea2040b81edf7427ee1fd0517ee5a07311019) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): copy `defaultHeaders` when constructing a `Client` instead of writing `x-api-key` into the caller's object. Previously, clients created from the same `defaultHeaders` object shared one set of headers, so a later client's API key was sent by earlier clients, and a client created with no API key could send another client's key to its own `apiUrl`.

## 1.12.2

### Patch Changes

- [#2944](https://github.com/langchain-ai/langgraphjs/pull/2944) [`413a9c7`](https://github.com/langchain-ai/langgraphjs/commit/413a9c77b647202ac87ce53a61de1e6f7a26e796) Thanks [@thushanth-bengre-langchain](https://github.com/thushanth-bengre-langchain)! - fix(sdk): URL-encode caller-supplied identifiers (thread, assistant, run, cron and checkpoint IDs, subgraph namespaces) in request paths so an untrusted ID can't redirect a request to another endpoint. IDs containing reserved characters such as `/`, `?`, `#`, `%` or spaces are now sent percent-encoded, so pass raw IDs rather than pre-encoded ones. `.` and `..` are no longer accepted as IDs: the method rejects with an `Invalid path segment` error instead of sending a request.

- [#2959](https://github.com/langchain-ai/langgraphjs/pull/2959) [`67cfdd2`](https://github.com/langchain-ai/langgraphjs/commit/67cfdd2cca7c752561cbb37675573d7004bba222) Thanks [@casparb](https://github.com/casparb)! - Export the Agent Server graph factory `ServerRuntime` type from `@langchain/langgraph-sdk`.

## 1.12.1

### Patch Changes

- [#2882](https://github.com/langchain-ai/langgraphjs/pull/2882) [`cca4806`](https://github.com/langchain-ai/langgraphjs/commit/cca48067b78fa9e3dc632c02a3431e74ff3f91b1) Thanks [@buenjybar](https://github.com/buenjybar)! - Fix `useStream`/`StreamOrchestrator` leaving stale, never-checkpointed messages visible after `stop()` cancels a run mid-turn. The buffer is now reconciled against the persisted thread state (refetching it when the caller needs authoritative thread state, otherwise falling back to the cached history) instead of only clearing on a thread switch or remount.

- [#2918](https://github.com/langchain-ai/langgraphjs/pull/2918) [`7343768`](https://github.com/langchain-ai/langgraphjs/commit/7343768628570b864dc50f25d0f2b38bf825ccb8) Thanks [@brydar](https://github.com/brydar)! - Stop the protocol SSE transport from retrying `stream/events` on 4xx responses (except 408 and 429): the stream now ends at once with the error. Protocol request errors now keep the HTTP `status` and response body `text`. The reconnect attempt counter now resets after every successful connect, so idle reconnects no longer use up `maxReconnectAttempts`.

## 1.12.0

### Minor Changes

- [#2848](https://github.com/langchain-ai/langgraphjs/pull/2848) [`7a12289`](https://github.com/langchain-ai/langgraphjs/commit/7a12289df4ed6441171ec393da4ccfccd98d69e8) Thanks [@thushanth-bengre-langchain](https://github.com/thushanth-bengre-langchain)! - `useStream`'s `"enqueue"` multitask strategy can now be backed by real, durable server-side runs instead of an in-memory client-only queue.
  
  Pass `queue: "server"` to opt in; it defaults to `"local"`, so existing usage is unaffected. `"server"` requires the backend behind `apiUrl` to implement the Runs REST endpoints (`POST`/`GET /threads/{thread_id}/runs`, `POST /threads/{thread_id}/runs/{run_id}/cancel`), not just streaming/commands. Queued submissions then persist across reloads and are visible to other sessions, and `cancelQueued`/`clearQueue` cancel them server-side too.
  
  Not supported with a custom `AgentServerAdapter` transport — `queue` only applies to the built-in transport.

## 1.12.0-rc.0

### Minor Changes

- [#2848](https://github.com/langchain-ai/langgraphjs/pull/2848) [`7a12289`](https://github.com/langchain-ai/langgraphjs/commit/7a12289df4ed6441171ec393da4ccfccd98d69e8) Thanks [@thushanth-bengre-langchain](https://github.com/thushanth-bengre-langchain)! - `useStream`'s `"enqueue"` multitask strategy can now be backed by real, durable server-side runs instead of an in-memory client-only queue.
  
  Pass `queue: "server"` to opt in; it defaults to `"local"`, so existing usage is unaffected. `"server"` requires the backend behind `apiUrl` to implement the Runs REST endpoints (`POST`/`GET /threads/{thread_id}/runs`, `POST /threads/{thread_id}/runs/{run_id}/cancel`), not just streaming/commands. Queued submissions then persist across reloads and are visible to other sessions, and `cancelQueued`/`clearQueue` cancel them server-side too.
  
  Not supported with a custom `AgentServerAdapter` transport — `queue` only applies to the built-in transport.

## 1.11.2

### Patch Changes

- [#2855](https://github.com/langchain-ai/langgraphjs/pull/2855) [`0284323`](https://github.com/langchain-ai/langgraphjs/commit/0284323b2d8457bd830ea987e93f03ebee8370ce) Thanks [@hntrl](https://github.com/hntrl)! - Preserve metadata from v2 message SSE events when constructing frontend message objects, so applications can inspect message provenance and model completion details without parsing raw events.
  
  - Retain namespace, graph node, callback `run_id`, and message-start metadata in `additional_kwargs`, including messages returned by awaiting a `StreamingMessage`.
  - Expose finish reasons and provider response metadata in `response_metadata` across message roles, accepting both Python `metadata` and JavaScript `responseMetadata` event fields.
  - Populate the standard AI `usage_metadata` field while retaining `additional_kwargs.usage` for compatibility. Preserve earlier usage when a finish event omits it.
  - Keep interleaved streams at the same namespace and node separate using callback `run_id`, while retaining fallback behavior for legacy events without run IDs.
  
  These fields describe individual messages and model calls: a finish reason does not identify the final response of a graph turn, and callback run IDs are not necessarily server run IDs. This change does not add an `is_final` marker or persist stream-only metadata into historical checkpoints.

## 1.11.1

### Patch Changes

- [#2824](https://github.com/langchain-ai/langgraphjs/pull/2824) [`e75f6a0`](https://github.com/langchain-ai/langgraphjs/commit/e75f6a08e96f65d201a0bb501a97e00bcffe83a2) Thanks [@eliornl](https://github.com/eliornl)! - feat(langgraph): add `responseSchema` option to `interrupt()`
  
  `interrupt(value, { responseSchema })` lets a graph declare the shape of the
  value it expects on resume. A Zod schema validates the resume value and the
  parsed result is what `interrupt()` returns; a raw JSON Schema object is passed
  through as-is. The schema is surfaced on `Interrupt.response_schema` so clients
  such as Studio can render a typed form instead of a free-form JSON editor.
  Omitting the option keeps today's behavior.

## 1.11.0

### Minor Changes

- [#2831](https://github.com/langchain-ai/langgraphjs/pull/2831) [`3234c69`](https://github.com/langchain-ai/langgraphjs/commit/3234c69530416e2709bf54c53472e640864e7de4) Thanks [@ramon-langchain](https://github.com/ramon-langchain)! - Expose connection lifecycle callbacks for built-in streaming transports.
  
  `onConnected` runs after the initial SSE or WebSocket connection becomes usable and after every successful reconnect. Its payload distinguishes an `initial` connection from a `reconnected` connection and includes the reconnect attempt number.
  
  `onReconnect` now also receives the scheduled `delayMs`, allowing applications to display accurate retry state before the next connection attempt. React, Vue, Svelte, and Angular stream hooks forward both callbacks.

### Patch Changes

- [#2831](https://github.com/langchain-ai/langgraphjs/pull/2831) [`3234c69`](https://github.com/langchain-ai/langgraphjs/commit/3234c69530416e2709bf54c53472e640864e7de4) Thanks [@ramon-langchain](https://github.com/ramon-langchain)! - Recover cleanly when a thread's root event stream terminates unexpectedly.
  
  If the stream fails or closes while a run is active, the controller now records the transport error and clears `isLoading` rather than leaving the UI in a permanently running state. Once the failed pump settles, a later submission can start a fresh root subscription without recreating the thread stream or replaying the failed command.

- [#2809](https://github.com/langchain-ai/langgraphjs/pull/2809) [`11a4535`](https://github.com/langchain-ai/langgraphjs/commit/11a4535762b04f8f28cc98eb7b1e4b682b69e91a) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): appropriately track persisted seq for stream replay
  
  Sequences weren't being appropriately attributed when rehydrating the page (e.g. on refresh). This meant we'd lose stream information on `useStream` on reloads. This has been fixed by adding a lookup step to determine what the most appropriate sequence index is to track in the event stream.:x

- [#2762](https://github.com/langchain-ai/langgraphjs/pull/2762) [`2fab6fd`](https://github.com/langchain-ai/langgraphjs/commit/2fab6fda74714cd792fed24e5416cec66fdbc105) Thanks [@JessYanCoding](https://github.com/JessYanCoding)! - Send `checkpoint_id` in the `runs.stream()` request body, so a `checkpointId` passed to `client.runs.stream()` forks from the requested checkpoint instead of being silently dropped. Matches `runs.create()` and `runs.wait()`, which already send it.

- [#2813](https://github.com/langchain-ai/langgraphjs/pull/2813) [`4fc118f`](https://github.com/langchain-ai/langgraphjs/commit/4fc118fcde8fd6d977c03c8a0a7071912df1873a) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): show interrupts raised after a passive thread rejoin
  
  After a page refresh mid-run, `useStream` filtered every interrupt it did not
  already know from the hydrated thread state as replayed history, and waited
  for a `checkpoints` event to lift that filter. Current runtimes never emit
  that event and the replay buffer trims it on long runs, so interrupts raised
  after the refresh never appeared until the next reload. Unknown interrupts are
  now settled against the server's thread state when the run reaches a terminal
  lifecycle: the ones the server lists as pending are shown, the rest are
  dropped as history.

- [#2812](https://github.com/langchain-ai/langgraphjs/pull/2812) [`db4bdad`](https://github.com/langchain-ai/langgraphjs/commit/db4bdad61ddfc6c1113269b131ac2efde3eecf69) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): recover from a server-side thread stream drop instead of freezing
  
  The protocol SSE transport now reconnects when the server closes the event
  stream cleanly. The thread stream is open-ended, so a clean close only happens
  when the server's own upstream consumer died or it is restarting; before, the
  client treated it as the end of the thread and the UI froze mid-run with no
  error. A connection that delivered events also resets the reconnect budget, so
  long-lived pages survive repeated deploys. `maxReconnectAttempts: 0` keeps the
  old end-on-close behavior.
  
  Unsolicited server error frames (no command id) and a shared stream that gives
  up reconnecting now reach `stream.error`: `ThreadStream.onError` exposes them,
  `useStream` sets `error`, clears `isLoading`, and settles the in-flight
  `submit()` as failed.

- [#2808](https://github.com/langchain-ai/langgraphjs/pull/2808) [`55fa26b`](https://github.com/langchain-ai/langgraphjs/commit/55fa26be9290fbd89a6e0acb232f04cbc6dedb22) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): coalesce locally resolved interrupts
  
  when resolving interrupts using `useStream`, there was a case where we prioritized the remote state values (which we lookup in React Strict mode on every page transition) over the local interrupt responses we know we've responded with.
  
  This has since been fixed to first prioritize the local cache of interrupts, resolved against the remote state values when a run hits a terminal event

## 1.10.3-rc.2

### Patch Changes

- [#2813](https://github.com/langchain-ai/langgraphjs/pull/2813) [`4fc118f`](https://github.com/langchain-ai/langgraphjs/commit/4fc118fcde8fd6d977c03c8a0a7071912df1873a) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): show interrupts raised after a passive thread rejoin
  
  After a page refresh mid-run, `useStream` filtered every interrupt it did not
  already know from the hydrated thread state as replayed history, and waited
  for a `checkpoints` event to lift that filter. Current runtimes never emit
  that event and the replay buffer trims it on long runs, so interrupts raised
  after the refresh never appeared until the next reload. Unknown interrupts are
  now settled against the server's thread state when the run reaches a terminal
  lifecycle: the ones the server lists as pending are shown, the rest are
  dropped as history.

- [#2812](https://github.com/langchain-ai/langgraphjs/pull/2812) [`db4bdad`](https://github.com/langchain-ai/langgraphjs/commit/db4bdad61ddfc6c1113269b131ac2efde3eecf69) Thanks [@eliornl](https://github.com/eliornl)! - fix(sdk): recover from a server-side thread stream drop instead of freezing
  
  The protocol SSE transport now reconnects when the server closes the event
  stream cleanly. The thread stream is open-ended, so a clean close only happens
  when the server's own upstream consumer died or it is restarting; before, the
  client treated it as the end of the thread and the UI froze mid-run with no
  error. A connection that delivered events also resets the reconnect budget, so
  long-lived pages survive repeated deploys. `maxReconnectAttempts: 0` keeps the
  old end-on-close behavior.
  
  Unsolicited server error frames (no command id) and a shared stream that gives
  up reconnecting now reach `stream.error`: `ThreadStream.onError` exposes them,
  `useStream` sets `error`, clears `isLoading`, and settles the in-flight
  `submit()` as failed.

## 1.10.3-rc.1

### Patch Changes

- [#2809](https://github.com/langchain-ai/langgraphjs/pull/2809) [`11a4535`](https://github.com/langchain-ai/langgraphjs/commit/11a4535762b04f8f28cc98eb7b1e4b682b69e91a) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): appropriately track persisted seq for stream replay
  
  Sequences weren't being appropriately attributed when rehydrating the page (e.g. on refresh). This meant we'd lose stream information on `useStream` on reloads. This has been fixed by adding a lookup step to determine what the most appropriate sequence index is to track in the event stream.:x

- [#2808](https://github.com/langchain-ai/langgraphjs/pull/2808) [`55fa26b`](https://github.com/langchain-ai/langgraphjs/commit/55fa26be9290fbd89a6e0acb232f04cbc6dedb22) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): coalesce locally resolved interrupts
  
  when resolving interrupts using `useStream`, there was a case where we prioritized the remote state values (which we lookup in React Strict mode on every page transition) over the local interrupt responses we know we've responded with.
  
  This has since been fixed to first prioritize the local cache of interrupts, resolved against the remote state values when a run hits a terminal event

## 1.10.3-rc.0

### Patch Changes

- [#2762](https://github.com/langchain-ai/langgraphjs/pull/2762) [`2fab6fd`](https://github.com/langchain-ai/langgraphjs/commit/2fab6fda74714cd792fed24e5416cec66fdbc105) Thanks [@JessYanCoding](https://github.com/JessYanCoding)! - Send `checkpoint_id` in the `runs.stream()` request body, so a `checkpointId` passed to `client.runs.stream()` forks from the requested checkpoint instead of being silently dropped. Matches `runs.create()` and `runs.wait()`, which already send it.

## 1.10.2

### Patch Changes

- [#2788](https://github.com/langchain-ai/langgraphjs/pull/2788) [`3d0bc90`](https://github.com/langchain-ai/langgraphjs/commit/3d0bc90635fa4748d14a4bedb1289448f18a9e92) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): apply in-place message metadata updates from values

  Same-id `values` snapshots that mutate nested metadata (e.g. HITL card
  `status: accepted → done`) without changing content were treated as no-ops
  because enrichment only accepted shallow key-supersets. Prefer values when
  they retain every nested key and only mutate leaves or add keys, so
  `useStream().values` reflects the update.

- [#2780](https://github.com/langchain-ai/langgraphjs/pull/2780) [`ac72c3d`](https://github.com/langchain-ai/langgraphjs/commit/ac72c3d270bc491f4a73abab4e3058ff090987c2) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): keep stream.interrupts truthful after sequential multi-interrupt resume

  Locally-resolved interrupt ids are no longer permanently suppressed: live
  `input.requested` events after the resume barrier can reappear, and a
  post-resume reconcile against `threads.getState().tasks[].interrupts`
  restores siblings the server still has pending. Prevents a stale-empty
  `stream.interrupts` from driving a free-text `submit()` into an ambiguous
  `Command(resume=…)` when multiple interrupts remain.

## 1.10.1

### Patch Changes

- [#2718](https://github.com/langchain-ai/langgraphjs/pull/2718) [`dd287b4`](https://github.com/langchain-ai/langgraphjs/commit/dd287b4c872db094e2fbc87e685da005a6ccdb90) Thanks [@jstar0](https://github.com/jstar0)! - Reject protocol SSE stream responses with non-SSE content types before marking subscriptions ready.

## 1.10.0

### Minor Changes

- [#2745](https://github.com/langchain-ai/langgraphjs/pull/2745) [`cef10ab`](https://github.com/langchain-ai/langgraphjs/commit/cef10ab35cefea12c36a8864cdf12f51c7553975) Thanks [@mdrxy](https://github.com/mdrxy)! - Add LangSmith replica routing to thread-stream run starts.

### Patch Changes

- [#2727](https://github.com/langchain-ai/langgraphjs/pull/2727) [`f8bdf16`](https://github.com/langchain-ai/langgraphjs/commit/f8bdf16d4fe23a79e945ea5dc6f86bbf09abb77d) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): drop unused svelte and vue peer dependencies

  The Svelte and Vue adapters live in `@langchain/svelte` and
  `@langchain/vue`, but the core SDK still declared both as optional peers.
  Scanners like Socket count optional peers as part of the package graph, so
  the SDK was being flagged for obfuscated-code alerts in `clsx` and
  `entities` — packages it never loads. React stays a peer because `./react`
  and `./react-ui` still ship here.

## 1.9.31

### Patch Changes

- [#2722](https://github.com/langchain-ai/langgraphjs/pull/2722) [`7b0fd47`](https://github.com/langchain-ai/langgraphjs/commit/7b0fd47287eb841d8f1068de93b46f49cab3c04d) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): don't re-show resolved interrupts after reload

  After a reload, the next submit used to replay the old `input.requested`
  event, so the HITL form came back even though the interrupt was already
  answered. Keep filtering historical interrupts after the command is
  accepted, using the response's `applied_through_seq` as the cutoff.

## 1.9.30

### Patch Changes

- [#2691](https://github.com/langchain-ai/langgraphjs/pull/2691) [`3ce9f8d`](https://github.com/langchain-ai/langgraphjs/commit/3ce9f8d11dd64b1d091a25162603c49e6f4a426f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): clear messages on hydrate(null) with a pending interrupt

  Teardown awaited the paused root pump, so threadId went null while
  the old conversation stayed on screen. Reset the snapshot first.

- [#2703](https://github.com/langchain-ai/langgraphjs/pull/2703) [`51b4202`](https://github.com/langchain-ai/langgraphjs/commit/51b42020f7c730a15193aa907056881e3d961924) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): keep isLoading true across interrupt→running hydration

  Deferred terminal resets no longer clear isLoading when a newer running lifecycle has already arrived (HITL resume / SSE replay).

- [#2692](https://github.com/langchain-ai/langgraphjs/pull/2692) [`a86f813`](https://github.com/langchain-ai/langgraphjs/commit/a86f813954e010fbf30711c37baa5c53444613d5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): adopt server metadata on same-id optimistic message echo

  When a `values` snapshot echoes an optimistic human with the same
  content plus committed `additional_kwargs` (e.g. attachment paths),
  `stream.messages` now takes the server copy instead of keeping the
  plain optimistic message until hydration. Preferring is asymmetric:
  lagging or poorer values snapshots do not strip richer current
  metadata. In-flight AI token streaming is unchanged: streamed content
  still wins when it has moved past the snapshot.

## 1.9.29

### Patch Changes

- [#2668](https://github.com/langchain-ai/langgraphjs/pull/2668) [`f9c0e88`](https://github.com/langchain-ai/langgraphjs/commit/f9c0e885e25149fe614d7d2002c884b80ab54484) Thanks [@edenbuilds](https://github.com/edenbuilds)! - Always attach the underlying Response on HTTPError.

- [#2675](https://github.com/langchain-ai/langgraphjs/pull/2675) [`3958305`](https://github.com/langchain-ai/langgraphjs/commit/3958305d3ee89419abc496f28602cf4b38f2a6b3) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): deliver input channel events on the root-bus fast path

  `channelProjection` with `replay: false` (the `useChannelEffect` default) compared `event.method` to channel names, so `input.requested` never matched `"input"`. Match via `inferChannel` instead, same as the slow path.

- [#2677](https://github.com/langchain-ai/langgraphjs/pull/2677) [`4c0fd78`](https://github.com/langchain-ai/langgraphjs/commit/4c0fd78485e1778234ddb56c7579f8d823946f18) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): defer stream join until lazy thread create commits

  Hydrating an externally-minted thread id that 404s still opened `/stream/events` before `POST /commands` created the row. On langgraph_api's in-mem runtime that join is accepted but dead, so the first run delivered nothing until idle reconnect. Treat missing threads like client-minted ones and start the root pump only after dispatch succeeds.

- [#2672](https://github.com/langchain-ai/langgraphjs/pull/2672) [`5be518f`](https://github.com/langchain-ai/langgraphjs/commit/5be518fe18f2497a28957dfec85522997e6df4f3) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): surface nested interrupts on stream.interrupts

  `input.requested` events from subgraphs/subagents were dropped live by a root-only filter, while hydrate seeded them from `state.tasks`, so HITL UIs saw nested interrupts only after reload. Mirror every namespace onto `rootStore.interrupts` (with `Interrupt.namespace`), and resolve that namespace in `respond({ interruptId })` when callers omit it.

- [#2676](https://github.com/langchain-ai/langgraphjs/pull/2676) [`b3c1ceb`](https://github.com/langchain-ai/langgraphjs/commit/b3c1ceb2cc16dcb15e7a9c1178fe6ddb98e5a93f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): resolve respond() namespace from interrupt id

  When callers pass `{ interruptId }` without `namespace`, look the
  namespace up on `thread.interrupts` instead of defaulting to root.

## 1.9.28

### Patch Changes

- [#2622](https://github.com/langchain-ai/langgraphjs/pull/2622) [`cf2407a`](https://github.com/langchain-ai/langgraphjs/commit/cf2407a31657a8308312873a13863f496b34f3ca) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): clear hydrate interrupt allowlist on respond()

  `submit()` already cleared `#hydratedActiveInterruptIds` so a new run's live `input.requested` events were not dropped as historical. `respond()` / `respondAll()` (via `dispatchResume`) did not, so a follow-on HITL after resume never appeared on `stream.interrupt` and free-text submits could resume with the wrong payload.

- [#2613](https://github.com/langchain-ai/langgraphjs/pull/2613) [`82a320f`](https://github.com/langchain-ai/langgraphjs/commit/82a320faf6876238f8bac8aa6a7c593bef2be061) Thanks [@sreeramsama](https://github.com/sreeramsama)! - Fix `useStream` crash (`TypeError: Cannot read properties of null (reading 'fetch')`) when a thread is cleared while hydration is in flight. The stale hydrate now bails immediately after the `getState()` await — it no longer applies the fetched state to the thread that was left, nor opens a reconnect via `threads.stream(null, …)`.

## 1.9.27

### Patch Changes

- [#2606](https://github.com/langchain-ai/langgraphjs/pull/2606) [`fa4658c`](https://github.com/langchain-ai/langgraphjs/commit/fa4658c79489eb5fb3e38744c34a6f5bf2373831) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): omit carried `since` on SSE reconnect

  Protocol `seq` is connection-scoped: a new `POST /stream/events` re-numbers Redis replay from 1, so advancing `since` from observed seqs and sending it after a successful open filtered out the full history (heartbeats only). An explicit caller `since` is still sent until the stream connects (including pre-ready retries); post-connect reconnects omit `since` and rely on durable `event_id` dedup.

## 1.9.26

### Patch Changes

- [#2605](https://github.com/langchain-ai/langgraphjs/pull/2605) [`f326b89`](https://github.com/langchain-ai/langgraphjs/commit/f326b89365043bfa846e0b428564bcafafab4aaa) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): keep SSE reconnect enabled with custom fetch

  Auth/proxy fetch shims previously forced `maxReconnectAttempts: 0`, so HITL waits that lost `/stream/events` (e.g. `ERR_QUIC_PROTOCOL_ERROR`) never recovered and left `respond()`/`submit()` spinning. Fail-fast test mocks should pass `maxReconnectAttempts: 0` explicitly. Also plumbs reconnect options through framework `useStream` bindings.

- [#2602](https://github.com/langchain-ai/langgraphjs/pull/2602) [`c201256`](https://github.com/langchain-ai/langgraphjs/commit/c201256b27d55c9aa333d3d15f6ec16c2fd7de9b) Thanks [@HugoDurand](https://github.com/HugoDurand)! - fix(sdk): support clearing a cron's end time via `crons.update(cronId, { endTime: null })`

  `CronsClient.update` now accepts `endTime: null` to clear a previously set cron end time; omitting `endTime` still leaves it unchanged. The field was typed `string`, so callers could not express "clear" even though the request already forwards an explicit `null`.

## 1.9.25

### Patch Changes

- [#2565](https://github.com/langchain-ai/langgraphjs/pull/2565) [`0558e47`](https://github.com/langchain-ai/langgraphjs/commit/0558e472b7697304c62cb6fe69cc3005e8e1a457) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): bundle pure-ESM deps into CJS build to fix ERR_REQUIRE_ESM

  Bundle the pure-ESM dependencies `p-retry` and `p-queue` (and their transitive ESM-only deps) into the build output so the CJS artifact no longer does a top-level `require()` of an ESM module. This fixes `ERR_REQUIRE_ESM` for CommonJS consumers on Node versions where `require(ESM)` is not enabled by default (< 20.19 / < 22.12). Closes [#2562](https://github.com/langchain-ai/langgraphjs/issues/2562).

## 1.9.24

### Patch Changes

- [#2557](https://github.com/langchain-ai/langgraphjs/pull/2557) [`b1e856d`](https://github.com/langchain-ai/langgraphjs/commit/b1e856d987ac16148dc0872d1fecf70e659ef28e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): apply state update and goto alongside interrupt resume

  `respond(decision, { update, goto })` now maps to LangGraph's
  `Command(resume, update, goto)`, so a human-in-the-loop UI can commit a state
  update (e.g. push the interrupt card into state) in the **same superstep** as
  the resume — one checkpoint, no separate `updateState` write, no flicker.
  `@langchain/langgraph-api` forwards `update`/`goto` through `input.respond`,
  and `@langchain/core` message instances in `update` are serialized to dicts
  before transport, exactly like `submit()`. Bumps `@langchain/protocol` to
  `^0.0.18` for the `Goto` type.

  `respond`/`respondAll` also apply `update` **optimistically** (mirroring
  `submit()`): the pushed messages paint immediately, with stable ids minted so
  the resumed run's echo reconciles them in place. Without this the interrupt is
  cleared the instant `respond()` dispatches while the pushed card only reappears
  a server round-trip later — so the card would flicker in that gap. The
  optimistic state settles on the resumed run's terminal (pending → sent, or
  rolled back on a failure before any echo).

  User-initiated optimistic writes (`submit()` / `respond()` / `respondAll()`) now
  commit to the store **synchronously**, in the same tick as the triggering event,
  instead of being coalesced onto the next macrotask. This lets a framework render
  the pushed message in the **same commit** as any local UI state the caller flips
  alongside it (e.g. a HITL form swapping its inputs for the resolved card), so the
  card no longer blinks out for the one-macrotask window before the flush lands.
  High-frequency streaming writes keep their macrotask coalescing.

## 1.9.23

### Patch Changes

- [#2545](https://github.com/langchain-ai/langgraphjs/pull/2545) [`2134c8a`](https://github.com/langchain-ai/langgraphjs/commit/2134c8a2c0bc8dd2ebea33e1191c8dd0c4b83236) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): avoid scoped stream resubscribe churn

  Defer final projection disposal by one microtask so framework bindings that release and immediately reacquire the same scoped projection during reactive updates keep the existing stream subscription instead of rotating through root-only and scoped SSE filters.

## 1.9.22

### Patch Changes

- [#2529](https://github.com/langchain-ai/langgraphjs/pull/2529) [`ba31f04`](https://github.com/langchain-ai/langgraphjs/commit/ba31f045d1d458a456c6f6441e8ee81d32c5c700) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): reconnect SSE streams when heartbeat idle is detected

  Detect half-open SSE connections by watching for server keep-alive heartbeats (`: heartbeat`) and reconnecting with Last-Event-ID or `since` when they stop. `"auto"` mode arms only after heartbeats are observed, so long tool calls and HITL pauses do not false-fire on heartbeat-emitting servers.

- [#2528](https://github.com/langchain-ai/langgraphjs/pull/2528) [`e7e8035`](https://github.com/langchain-ai/langgraphjs/commit/e7e8035fadca5f0d4cbc55bbbb77e65878ab2952) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Allow custom `AgentServerAdapter`s to be late-bound and re-bound to a thread. Adapters can now implement an optional `setThreadId(threadId)`, which `client.threads.stream(threadId, { transport })` calls when binding the active thread — including the lazily-minted id from the first `submit()` on a `threadId: null` controller. The built-in `ProtocolSseTransportAdapter`, `ProtocolWebSocketTransportAdapter`, and `HttpAgentServerAdapter` implement it: `threadId` is now optional at construction, request URLs derive from the currently-bound thread, and `paths` entries may be functions of the thread id (`(threadId) => string`). This lets a single custom transport back a lazy thread-creation flow instead of being pinned to one thread at construction.

- [#2527](https://github.com/langchain-ai/langgraphjs/pull/2527) [`9e114e5`](https://github.com/langchain-ai/langgraphjs/commit/9e114e55d362a874878a817740de42fd62ae9db7) Thanks [@christian-bromann](https://github.com/christian-bromann)! - chore(deps): remove uuid dependency in favor of embedded uuid in core

  Replace direct `uuid` package imports with `@langchain/core/utils/uuid` across
  langgraph packages to deduplicate dependencies and align with @langchain/core's
  embedded UUID utilities.

## 1.9.21

### Patch Changes

- [#2522](https://github.com/langchain-ai/langgraphjs/pull/2522) [`3855985`](https://github.com/langchain-ai/langgraphjs/commit/3855985dd049739f145295d236ce6aa02ae2fb0e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(stream): add per-event side-effect selector

  Add `useChannelEffect` (React/Svelte/Vue) / `injectChannelEffect` (Angular), a side-effect counterpart to `useChannel` that invokes an `onEvent` callback once per raw protocol event without re-rendering. This is the idiomatic v1 replacement for the old `onLangChainEvent` / `onCustomEvent` callbacks for analytics and logging. Backed by a new framework-agnostic `acquireChannelEffect` helper in `@langchain/langgraph-sdk/stream` that shares a ref-counted subscription with matching `useChannel` consumers.

- [#2523](https://github.com/langchain-ai/langgraphjs/pull/2523) [`7c3e9e9`](https://github.com/langchain-ai/langgraphjs/commit/7c3e9e93f3c7ec1dc654dac8ee8c03562ee8337b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): stop re-streaming seeded messages on idle-thread submit

  An idle (finished) thread defers its root SSE pump, so the first `submit()` brings it up and the transport replays the finished run from `seq=0`. The replayed `messages` channel carries no step (unlike `values`, guarded by `maxStep`), so it rebuilt each already-complete message from an empty `message-start` and re-streamed the whole turn token-by-token — a visible "messages replay" of the existing conversation. Seal the message ids seeded from the idle `getState()` snapshot so replayed deltas can't downgrade the complete tail; the seal lifts once a newer checkpoint advances the timeline or on thread rebind, and ids from the next run are never sealed.

- [#2462](https://github.com/langchain-ai/langgraphjs/pull/2462) [`17c44a3`](https://github.com/langchain-ai/langgraphjs/commit/17c44a38b7478e2bc4fe908a54c78ef33fb68ba3) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): reconnect v2 SSE and WebSocket thread streams after disconnect

  Add automatic reconnect with resume (`since` for SSE) for protocol transports,
  wire `AsyncCaller` through `client.threads.stream`, and expose optional
  reconnect tuning on `ThreadStreamOptions`. Includes integration tests against
  an in-process mock langgraph-api server.

## 1.9.20

### Patch Changes

- [#2508](https://github.com/langchain-ai/langgraphjs/pull/2508) [`41cd05a`](https://github.com/langchain-ai/langgraphjs/commit/41cd05a411ed262443c2bd1048e1b728b7331ac6) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): hydrate custom HttpAgentServerAdapter via transport getState

  StreamController now prefers adapter getState() before client.threads.getState,
  HttpAgentServerAdapter implements GET /threads/:id/state, and useStream inherits
  apiUrl from the transport so hydration no longer defaults to localhost:8123.

## 1.9.19

### Patch Changes

- [#2505](https://github.com/langchain-ai/langgraphjs/pull/2505) [`cad31b4`](https://github.com/langchain-ai/langgraphjs/commit/cad31b42f001a87fcdf57c4c084c655c8762b6a5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Deduplicate the client stream transports: the protocol transport now shares the SSE decoder and `IterableReadableStream` helpers with the legacy transport instead of carrying its own copies. Removes the redundant `transport/decoder.ts` and `transport/stream.ts` shims (and a dead `StreamPart` re-export), importing the shared utilities from `utils/sse.ts` directly. No public API or behavior change.

## 1.9.18

### Patch Changes

- [#2500](https://github.com/langchain-ai/langgraphjs/pull/2500) [`f67772f`](https://github.com/langchain-ai/langgraphjs/commit/f67772ff3f7ac13d81576d395d7529de4eb4390b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): resume useChannel subscriptions across serial runs

  Enable `resumeOnPause` on the channel projection so `useChannel` keeps
  accumulating events across prompts on the same thread. Clarify selector
  docs and JSDoc: `useChannel` for the full event stream, `useExtension`
  for the latest payload.

## 1.9.17

### Patch Changes

- [#2494](https://github.com/langchain-ai/langgraphjs/pull/2494) [`0a0e04e`](https://github.com/langchain-ai/langgraphjs/commit/0a0e04e9ff7e82fd08411cc0094e1f94729a1e1e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): revive automatic optimistic submit echo

  Echo `submit()` input into `values` / `messages` immediately with client-side
  id minting and id-based reconciliation as the server streams back. Expose
  per-message `optimisticStatus` via message metadata (`pending` → `sent` /
  `failed`), shallow-merge non-message keys with rollback when no `values`
  arrive, and add an `optimistic: false` hook opt-out. Plumb through React,
  Vue, Svelte, and Angular with browser e2e coverage.

- [`658a076`](https://github.com/langchain-ai/langgraphjs/commit/658a076d5b50af9f5b96ab99f26ed629da6e182f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): coalesce duplicate thread read requests

  Coalesce concurrent identical `threads.getState()` and `threads.getHistory()` reads within the SDK client so transient remounts do not issue duplicate hydrate requests. Request identity includes the prepared URL, body, method, and headers, and coalescing is skipped for caller-provided abort signals, raw response reads, and `onRequest` hooks to preserve auth and cancellation isolation.

- [#2497](https://github.com/langchain-ai/langgraphjs/pull/2497) [`a9aa8d6`](https://github.com/langchain-ai/langgraphjs/commit/a9aa8d6a9b23f5f7d4c56889fa68697b1e076b31) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): reconcile subagents and subgraphs on thread reconnect

  Seed deep-agent subagent cards from checkpoint messages and subgraph hosts from a single bounded `getHistory` read during `hydrate()`, so parallel fan-out discovery reappears immediately on refresh instead of waiting for SSE replay. Subagent execution namespaces are promoted through the existing guarded discovery state machine (bulk at hydrate, lazily per opened card via the selector layer). The getHistory cost is O(1) in requests regardless of fan-out width.

## 1.9.16

### Patch Changes

- [#2486](https://github.com/langchain-ai/langgraphjs/pull/2486) [`244c24e`](https://github.com/langchain-ai/langgraphjs/commit/244c24eaccff4009df7d83e4320e51a4b310b15f) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): surface resumed run failures on stream.error

  Route `respond()` and `respondAll()` through a coordinator dispatch path that
  writes the reactive `rootStore.error` slot when a resumed run reaches a failed
  terminal or when `input.respond` dispatch fails, matching submit() behavior so
  framework consumers (e.g. API-key retry UIs) observe resume failures via
  `stream.error` instead of only `isLoading` transitions.

## 1.9.15

### Patch Changes

- [#2484](https://github.com/langchain-ai/langgraphjs/pull/2484) [`9861f42`](https://github.com/langchain-ai/langgraphjs/commit/9861f42cc4fa23d9e80ae45a76d511d7618cda07) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): claim in-flight slot before root pump wait for enqueue

  Move `#runAbort` and `isLoading` setup ahead of `waitForRootPumpReady()` so
  `multitaskStrategy: "enqueue"` submits in the same tick land in `queueStore`
  instead of bypassing the client queue.

## 1.9.14

### Patch Changes

- [#2482](https://github.com/langchain-ai/langgraphjs/pull/2482) [`ba583b6`](https://github.com/langchain-ai/langgraphjs/commit/ba583b601d284c689bbfc15397686f1aa7481fba) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): keep subgraph status complete when values arrives late

  `SubgraphDiscovery` no longer downgrades a terminal subgraph back to
  `running` when a host-namespace `values` snapshot is observed after its
  `completed` or `failed` lifecycle event. The content pump and lifecycle
  watcher are independent streams, so this reordering could strand nodes as
  perpetually running in `useStream` subgraph UIs.

## 1.9.13

### Patch Changes

- [#2469](https://github.com/langchain-ai/langgraphjs/pull/2469) [`0bbe66e`](https://github.com/langchain-ai/langgraphjs/commit/0bbe66e31de3abe7526c7810755a40c31bc60e0d) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): normalize HITL edit decisions for Python servers

  `StreamController.respond()` now mirrors camelCase and snake_case on edit
  decisions (`editedAction` / `edited_action`) so JS clients can resume
  human-in-the-loop interrupts against Python LangGraph servers.

## 1.9.12

### Patch Changes

- [#2467](https://github.com/langchain-ai/langgraphjs/pull/2467) [`0491534`](https://github.com/langchain-ai/langgraphjs/commit/04915347128e40fc9617647cadba6b472a357d36) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): route headless tool resumes through respond on v1 stream

  `useStream` was calling `submit(null, { command })` for headless-tool resumes,
  which dispatches `run.start` without delivering the tool result. Add
  `applyHeadlessToolResumeCommand` to route payloads through `respond` /
  `respondAll`, and tighten headless-tool browser tests to assert end-to-end
  resume and graph completion.

## 1.9.11

### Patch Changes

- [#2455](https://github.com/langchain-ai/langgraphjs/pull/2455) [`863b555`](https://github.com/langchain-ai/langgraphjs/commit/863b555346de02c2c0be290e877b7d260a3f8856) Thanks [@JHSeo-git](https://github.com/JHSeo-git)! - fix(sdk): prefer completed task's direct mapping over pending checkpoint's positional guess in fetchSubagentHistory

- [#2344](https://github.com/langchain-ai/langgraphjs/pull/2344) [`0125920`](https://github.com/langchain-ai/langgraphjs/commit/0125920a2c4a87dc1d66aaf541ea16146f8cf842) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps): bump uuid to 14.0.0 and keep checkpoint ID ordering stable

  Bump `uuid` from 10.x/13.x to 14.0.0 across packages. Starting with uuid 11, `v6({ clockseq })` no longer advances the sub-millisecond time counter when an explicit `clockseq` is passed, so checkpoint IDs created within the same millisecond were ordered only by `clockseq`. Since checkpoint IDs are sorted lexicographically, this broke ordering — most visibly for the negative `clockseq` used by the first ("input") checkpoint, which sorted as the newest.

  `uuid6()` now maintains its own monotonic `(msecs, nsecs)` clock (mirroring uuid 10's internal v1 behavior) so the time component is always strictly increasing and checkpoint ordering no longer depends on the `clockseq` value. `emptyCheckpoint()` also uses a non-negative `clockseq`.

## 1.9.10

### Patch Changes

- [#2447](https://github.com/langchain-ai/langgraphjs/pull/2447) [`80c2806`](https://github.com/langchain-ai/langgraphjs/commit/80c2806cb2da93745a640664bd0cf603c2361da9) Thanks [@christian-bromann](https://github.com/christian-bromann)! - protocol-v2: fold forkFrom client-side and honor per-run multitaskStrategy

  The SDK now folds the ergonomic `forkFrom` option into
  `config.configurable.checkpoint_id` before sending `run.start`, so the
  agent server only ever accepts the single, legacy-compliant fork field
  (`forkFrom` no longer hits the wire). The protocol-v2 reference servers
  drop their top-level `forkFrom` normalization accordingly.

  The protocol-v2 servers now honor the caller's `multitaskStrategy` per
  run (one of `reject` | `rollback` | `interrupt` | `enqueue`) instead of
  hardcoding it, falling back to `enqueue` when omitted or unrecognized.

- [#2443](https://github.com/langchain-ai/langgraphjs/pull/2443) [`80a8c12`](https://github.com/langchain-ai/langgraphjs/commit/80a8c1200a240fd984edc4deb26a7787d08c7532) Thanks [@christian-bromann](https://github.com/christian-bromann)! - refactor(sdk): drop StreamSubmitOptions.command and simplify forkFrom

  Remove the misleading submit({ command }) surface from protocol-v2
  StreamController; HITL resume is respond() only. Accept forkFrom as a
  plain checkpoint id string and align protocol-v2 servers and docs.

- [#2448](https://github.com/langchain-ai/langgraphjs/pull/2448) [`2c14b12`](https://github.com/langchain-ai/langgraphjs/commit/2c14b12a80c306578563e77595943037c7c4844d) Thanks [@christian-bromann](https://github.com/christian-bromann)! - protocol-v2: add `respondAll()` and run config/metadata on interrupt resume

  The stream controller (and the React/Angular/Svelte/Vue wrappers) gain a
  `respondAll(responsesById, options)` method to resume several interrupts
  pending at the same checkpoint in a single command — required for runs that
  pause on multiple interrupts at once (e.g. parallel tool-authorization
  prompts), which sequential `respond()` calls cannot handle.

  `respond()` now takes an options object (`{ interruptId?, namespace?,
config?, metadata? }`) so a resumed run can carry the same run-level config
  (model, user context, …) and metadata (trigger source, test flags, …) a
  fresh `submit()` would. The protocol-v2 reference servers read the new
  `responses` batch and `config` / `metadata` fields leniently and fold them
  onto the run that services the `input.respond` command.

## 1.9.9

### Patch Changes

- [#2441](https://github.com/langchain-ai/langgraphjs/pull/2441) [`dbbcb63`](https://github.com/langchain-ai/langgraphjs/commit/dbbcb636e742c38e89854a8ae7ef4e1566d44343) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): preserve apiUrl path prefix in stream transport URLs

  Use BaseClient-style URL concatenation in `toAbsoluteUrl` so SSE and WebSocket
  subscriptions work when the SDK is pointed at a proxied apiUrl with a path
  prefix (e.g. `/api/chat-langchain`).

## 1.9.8

### Patch Changes

- [#2438](https://github.com/langchain-ai/langgraphjs/pull/2438) [`29d2bde`](https://github.com/langchain-ai/langgraphjs/commit/29d2bde235bf85e8a5e1dd59a997266ff894484b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): cancel runs on stop by default and add disconnect()

  `stream.stop()` now calls `client.runs.cancel` for the active run before disconnecting the client (default `{ cancel: true }`). Join/rejoin UIs can call `stream.disconnect()` or `stop({ cancel: false })` to leave the agent running server-side.

  This fills a missing gap we found when migrating to v1.

## 1.9.7

### Patch Changes

- [#2435](https://github.com/langchain-ai/langgraphjs/pull/2435) [`cfc8d27`](https://github.com/langchain-ai/langgraphjs/commit/cfc8d274e4dc99cb73ebd9abc4f971622105f08e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): unwrap Command tool outputs and hide scoped task tools

  Filter wrapper `task` dispatch events from subagent-scoped tool-call
  projections and parse embedded ToolMessage results from LangGraph
  `Command` payloads on `tool-finished`.

- [#2434](https://github.com/langchain-ai/langgraphjs/pull/2434) [`6b188e8`](https://github.com/langchain-ai/langgraphjs/commit/6b188e80ab989fc8396e1926f729d93b786ca671) Thanks [@hntrl](https://github.com/hntrl)! - fix(react): avoid eager stream getter evaluation during object spread

  Mark optional `useStream` accessors as non-enumerable so object spread/rest destructuring does not accidentally read guarded fields like `history` or opt into additional stream modes.

## 1.9.6

### Patch Changes

- [#2430](https://github.com/langchain-ai/langgraphjs/pull/2430) [`f99941f`](https://github.com/langchain-ai/langgraphjs/commit/f99941f5fe8671ddcb6a78e93e5e05f4028d4af4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): clear subgraph and subagent discovery on thread swap

  Reset discovery stores in `StreamController.#teardownThread()` so starting a
  new thread does not leave stale subgraph cards or subagent entries from the
  previous run.

## 1.9.5

### Patch Changes

- [#2421](https://github.com/langchain-ai/langgraphjs/pull/2421) [`3529e38`](https://github.com/langchain-ai/langgraphjs/commit/3529e3831a488134e7dfaefa4ed7fb1140cf8bb6) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(stream): align AssembledToolCall typing with pre-v1 expectations

  Make `InferToolCalls` resolve to generic `AssembledToolCall` unions, expose
  sync `status`/`error` for reactive bindings, and align type tests across
  React, Vue, Svelte, and Angular SDK packages.

## 1.9.4

### Patch Changes

- [#2415](https://github.com/langchain-ai/langgraphjs/pull/2415) [`9d3c9dd`](https://github.com/langchain-ai/langgraphjs/commit/9d3c9dd3182059f9eca9fd9b14d8f7466b4338c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Move `@langchain/core` from a runtime dependency back to a required peer dependency so installing the SDK alone no longer pulls in `@langchain/core` (and `js-tiktoken`, etc.). Consumers that use streaming or message coercion must install `@langchain/core` explicitly or via `@langchain/langgraph`.

## 1.9.3

### Patch Changes

- [#2387](https://github.com/langchain-ai/langgraphjs/pull/2387) [`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Coalesce `RootMessageProjection` store writes through a single `setTimeout(0)` flush so long `messages`-channel replays (on refresh, mid-run join, or rapid subagent streaming) no longer drain as a per-event microtask chain that trips React's `Maximum update depth exceeded` guard. Replaces the previous `MessageChannel`-based batching, which deferred initial-submit events past the first render and left the UI looking frozen until refresh.

- [#2372](https://github.com/langchain-ai/langgraphjs/pull/2372) [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7) Thanks [@ahmed-z0](https://github.com/ahmed-z0)! - Fix subagent message routing to prefer the stream event namespace over checkpoint metadata when filtering subagent messages.

- [#2384](https://github.com/langchain-ai/langgraphjs/pull/2384) [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - batch RootMessageProjection store writes through a macrotask

- [#2388](https://github.com/langchain-ai/langgraphjs/pull/2388) [`01dd046`](https://github.com/langchain-ai/langgraphjs/commit/01dd0462ed300dee5a9a51f229e6c401315f070c) Thanks [@hntrl](https://github.com/hntrl)! - fix(sdk): retry connection failures before throwing ConnectionError

- [#2381](https://github.com/langchain-ai/langgraphjs/pull/2381) [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - fix(sdk): forward config + metadata on respondInput for resume submits

- [#2379](https://github.com/langchain-ai/langgraphjs/pull/2379) [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - filter SSE-replayed input.requested events through a hydrated interrupt allowlist

- [#2390](https://github.com/langchain-ai/langgraphjs/pull/2390) [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Bind deepagents subagent discovery to the execution namespace via taskInput so `useMessages(stream, subagent)` resolves the streaming scope instead of the trigger tool-call namespace.

## 1.9.3-rc.0

### Patch Changes

- [#2387](https://github.com/langchain-ai/langgraphjs/pull/2387) [`44746b1`](https://github.com/langchain-ai/langgraphjs/commit/44746b1a3b5b49737542b120b9e45d6f94181113) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Coalesce `RootMessageProjection` store writes through a single `setTimeout(0)` flush so long `messages`-channel replays (on refresh, mid-run join, or rapid subagent streaming) no longer drain as a per-event microtask chain that trips React's `Maximum update depth exceeded` guard. Replaces the previous `MessageChannel`-based batching, which deferred initial-submit events past the first render and left the UI looking frozen until refresh.

- [#2372](https://github.com/langchain-ai/langgraphjs/pull/2372) [`4cc6491`](https://github.com/langchain-ai/langgraphjs/commit/4cc6491844f21ed0fc737eaef8498133daa877f7) Thanks [@ahmed-z0](https://github.com/ahmed-z0)! - Fix subagent message routing to prefer the stream event namespace over checkpoint metadata when filtering subagent messages.

- [#2384](https://github.com/langchain-ai/langgraphjs/pull/2384) [`ae8af2d`](https://github.com/langchain-ai/langgraphjs/commit/ae8af2d75aef9a7bbd930d221d1ce03e7fbb90ad) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - batch RootMessageProjection store writes through a macrotask

- [#2381](https://github.com/langchain-ai/langgraphjs/pull/2381) [`2ad1aa4`](https://github.com/langchain-ai/langgraphjs/commit/2ad1aa48c6a3f45340b4833e6de555fdc7348d15) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - fix(sdk): forward config + metadata on respondInput for resume submits

- [#2379](https://github.com/langchain-ai/langgraphjs/pull/2379) [`75e651b`](https://github.com/langchain-ai/langgraphjs/commit/75e651b9cff1a1e39ad6513b8a5e9b565b9ad7fe) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - filter SSE-replayed input.requested events through a hydrated interrupt allowlist

- [#2390](https://github.com/langchain-ai/langgraphjs/pull/2390) [`f1d651a`](https://github.com/langchain-ai/langgraphjs/commit/f1d651ae14ca178f4a915ac853ba9b439cd55ba3) Thanks [@nick-hollon-lc](https://github.com/nick-hollon-lc)! - Bind deepagents subagent discovery to the execution namespace via taskInput so `useMessages(stream, subagent)` resolves the streaming scope instead of the trigger tool-call namespace.

## 1.9.2

### Patch Changes

- [#2370](https://github.com/langchain-ai/langgraphjs/pull/2370) [`4c6875c`](https://github.com/langchain-ai/langgraphjs/commit/4c6875c1e3dd32857d526925865c389e4e9c10c2) Thanks [@open-swe](https://github.com/apps/open-swe)! - feat(sdk): support metadata filter for crons search/count

- [#2377](https://github.com/langchain-ai/langgraphjs/pull/2377) [`a5089cd`](https://github.com/langchain-ai/langgraphjs/commit/a5089cda1d9db1e4b50c17cdd12a770a67279905) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): preserve AI content blocks during message projection

## 1.9.1

### Patch Changes

- [#2366](https://github.com/langchain-ai/langgraphjs/pull/2366) [`2bb66bf`](https://github.com/langchain-ai/langgraphjs/commit/2bb66bf816a8b18b2968ed885ef2df15f684cb4e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): update endpoints

## 1.9.0

### Minor Changes

- [#2314](https://github.com/langchain-ai/langgraphjs/pull/2314) [`085a07f`](https://github.com/langchain-ai/langgraphjs/commit/085a07f569b6d7d79728eb7eb6eb3a0c67fcdefb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Add the framework-agnostic event streaming SDK.

  The SDK now includes a thread-focused streaming client built around
  `ThreadStream`, `SubscriptionHandle`, message assembly, media assembly, typed
  stream extensions, and pluggable protocol transports. Applications can stream
  over SSE or WebSocket, provide custom agent-server adapters, subscribe to
  values/messages/tools/custom/lifecycle/checkpoint channels, inspect and fork
  state, respond to interrupts, and replay or dedupe ordered event streams.

  This release also adds the reusable stream runtime used by the React, Vue,
  Svelte, and Angular packages: `StreamController`, `StreamStore`,
  `ChannelRegistry`, projection factories, subagent/subgraph discovery,
  submission queue coordination, message metadata tracking, root message
  projection, media projections, and helper types for agent/deep-agent state and
  tool-call inference.

  The client package has been reorganized into focused modules for assistants,
  threads, runs, store, protocol streaming, transports, media, messages, and UI
  helpers. New SDK documentation covers configuration, assistants, threads, runs,
  store, streaming, transports, extensions, interrupts, messages, media,
  subagents, and subgraphs.

### Patch Changes

- [#2363](https://github.com/langchain-ai/langgraphjs/pull/2363) [`d1e2fda`](https://github.com/langchain-ai/langgraphjs/commit/d1e2fda1b1165e122362780a62ab8d2ebff9f9b9) Thanks [@cwlbraa](https://github.com/cwlbraa)! - Add a `returnMinimal` option to `threads.update`.

## 1.8.10

### Patch Changes

- [#2340](https://github.com/langchain-ai/langgraphjs/pull/2340) [`6bab458`](https://github.com/langchain-ai/langgraphjs/commit/6bab458d4a03ce2d7b2708488b92226899eb94d4) Thanks [@cwlbraa](https://github.com/cwlbraa)! - Respect `fetchStateHistory` when restoring subagent history.

## 1.8.9

### Patch Changes

- [#2302](https://github.com/langchain-ai/langgraphjs/pull/2302) [`458d66b`](https://github.com/langchain-ai/langgraphjs/commit/458d66bf665468854abb8133594d4d4f966054ed) Thanks [@AdrianSajjan](https://github.com/AdrianSajjan)! - fix(sdk): preserve messages on interrupt values events

  Add a regression test for interrupt-only `values` payloads to ensure
  previously streamed messages are not overwritten when `__interrupt__` is emitted.

## 1.8.8

### Patch Changes

- [#2292](https://github.com/langchain-ai/langgraphjs/pull/2292) [`33293c7`](https://github.com/langchain-ai/langgraphjs/commit/33293c7f3f110bb462d77a2f8671e5b9d0e84b63) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): buffer subagent messages instead of dropping them

## 1.8.7

### Patch Changes

- [#2285](https://github.com/langchain-ai/langgraphjs/pull/2285) [`a5dfdb6`](https://github.com/langchain-ai/langgraphjs/commit/a5dfdb61c7af0b957b0064b02cb390a11cd59b56) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): detect interrupt for Python agents

## 1.8.6

### Patch Changes

- [`b4a841c`](https://github.com/langchain-ai/langgraphjs/commit/b4a841c4b369db7f0fa93fe1de6b3b1ac3e8d3fb) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): bump all packages

## 1.8.5

### Patch Changes

- [#2279](https://github.com/langchain-ai/langgraphjs/pull/2279) [`3bbb3ff`](https://github.com/langchain-ai/langgraphjs/commit/3bbb3ff65aa3c1de96c7d751c14dc9ee11e3b095) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): better type inferrence

- [#2278](https://github.com/langchain-ai/langgraphjs/pull/2278) [`0d04099`](https://github.com/langchain-ai/langgraphjs/commit/0d04099958dcca0a1ed053e6a41cc2c12bab78f5) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(vue): Make subagents accessible once they are spun up

## 1.8.4

### Patch Changes

- [#2263](https://github.com/langchain-ai/langgraphjs/pull/2263) [`936b48b`](https://github.com/langchain-ai/langgraphjs/commit/936b48b2807687d3fa5dd7aa480ebcc2ad3ffccf) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Restore deprecated snake_case aliases on human-in-the-loop interrupt payloads
  while preserving the newer camelCase fields so older apps can migrate to
  `@langchain/react` without breaking interrupt handling.

## 1.8.3

### Patch Changes

- [#2204](https://github.com/langchain-ai/langgraphjs/pull/2204) [`d9d807e`](https://github.com/langchain-ai/langgraphjs/commit/d9d807ebb0398a43a07412fb034a65fc598c0731) Thanks [@brydar](https://github.com/brydar)! - fix(sdk): accumulate parallel interrupts in StreamManager

## 1.8.2

### Patch Changes

- [#2250](https://github.com/langchain-ai/langgraphjs/pull/2250) [`8eaf410`](https://github.com/langchain-ai/langgraphjs/commit/8eaf41069264753947e5c9633b567e589dc0e532) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): skip post-stream getHistory for zero-arity onFinish

## 1.8.1

### Patch Changes

- [#2237](https://github.com/langchain-ai/langgraphjs/pull/2237) [`88726df`](https://github.com/langchain-ai/langgraphjs/commit/88726dfe222aed64e5cd5dfa6f77f886b5a0d205) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Extract shared `WithClassMessages<T>` type to `@langchain/langgraph-sdk/ui`

- [#2243](https://github.com/langchain-ai/langgraphjs/pull/2243) [`7dfcbff`](https://github.com/langchain-ai/langgraphjs/commit/7dfcbffd4805b2b4cc41f07f30be57ed732786b4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(skd): normalize interrupts between JS and Python

## 1.8.0

### Minor Changes

- [#2227](https://github.com/langchain-ai/langgraphjs/pull/2227) [`414a7ad`](https://github.com/langchain-ai/langgraphjs/commit/414a7adf908ba4f7ffef4985df3a95f14202591b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat: extract shared orchestrator to eliminate duplicated code across SDK packages

## 1.7.5

### Patch Changes

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Support `onFinish` callback in custom transport, ensuring it is called when the stream completes.

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): fetch subagent history

- [`fe4dd5b`](https://github.com/langchain-ai/langgraphjs/commit/fe4dd5b85d285f78b6d499b1f1013927931ea634) Thanks [@christian-bromann](https://github.com/christian-bromann)! - Forward streamSubgraphs in custom transports

## 1.7.4

### Patch Changes

- [#2200](https://github.com/langchain-ai/langgraphjs/pull/2200) [`3873f36`](https://github.com/langchain-ai/langgraphjs/commit/3873f36c42e4fb1a2cd797a02e37875b16455cfe) Thanks [@hntrl](https://github.com/hntrl)! - Add checkpointId support to threads.updateState, runs.create, and runs.wait methods

## 1.7.3

### Patch Changes

- [#2189](https://github.com/langchain-ai/langgraphjs/pull/2189) [`8fec72a`](https://github.com/langchain-ai/langgraphjs/commit/8fec72ae98b117b79048403d0f7ad75d653c090b) Thanks [@pawel-twardziak](https://github.com/pawel-twardziak)! - Fix `getSubagentsByMessage` returning empty array for OpenAI models by updating `aiMessageId` when the provider replaces it during streaming.

- [#2170](https://github.com/langchain-ai/langgraphjs/pull/2170) [`a9ff2ef`](https://github.com/langchain-ai/langgraphjs/commit/a9ff2efdf0a2b6ff0301eedfff541e125c1e6300) Thanks [@jdrogers940](https://github.com/jdrogers940)! - add cancelMany method to sdk

- [#2173](https://github.com/langchain-ai/langgraphjs/pull/2173) [`a24bb55`](https://github.com/langchain-ai/langgraphjs/commit/a24bb550fb81271c505b9cab0295d8e599aaeb79) Thanks [@hinthornw](https://github.com/hinthornw)! - Adds threads.prune and updates SDK methods to have latest values.

- [#2177](https://github.com/langchain-ai/langgraphjs/pull/2177) [`b80076c`](https://github.com/langchain-ai/langgraphjs/commit/b80076c5a7fc1b6985abc1fd9c367438ba6ca968) Thanks [@hntrl](https://github.com/hntrl)! - handle null values in functional graph checkpoint history

## 1.7.2

### Patch Changes

- [#2168](https://github.com/langchain-ai/langgraphjs/pull/2168) [`98da019`](https://github.com/langchain-ai/langgraphjs/commit/98da019c926c684c01fe7b598cad57cf6f929268) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): revert dependency between old SDK and new react package

## 1.7.1

### Patch Changes

- [#2014](https://github.com/langchain-ai/langgraphjs/pull/2014) [`745112c`](https://github.com/langchain-ai/langgraphjs/commit/745112c0d754d0403aab415f46550dd61474dbd9) Thanks [@TheComputerM](https://github.com/TheComputerM)! - fix: use optimistic threadId in a custom stream

- [#2165](https://github.com/langchain-ai/langgraphjs/pull/2165) [`8faf05c`](https://github.com/langchain-ai/langgraphjs/commit/8faf05c939051effda4d3566d2f24a0a96ae7a56) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(sdk): convert history messages to BaseMessage instances in framework SDKs

  When accessing `stream.history` in the framework SDK packages (React,
  Svelte, Angular, Vue), messages within thread state values are now
  converted to proper @langchain/core BaseMessage class instances (e.g.
  HumanMessage, AIMessage) instead of being returned as plain objects.

  The base `@langchain/langgraph-sdk` package is intentionally unchanged
  and continues to return plain Message dicts for backward compatibility.

  - Add `ensureHistoryMessageInstances` utility to convert messages within
    ThreadState values to BaseMessage instances
  - Add `HistoryWithBaseMessages` type utility so `state.values.messages`
    is typed as `BaseMessage[]` in framework SDK history
  - Update `WithClassMessages` in all four framework SDKs to remap the
    `history` property type accordingly
  - Add unit tests (messages.test.ts) and type tests (stream-types.test-d.ts)
    in the base SDK verifying plain Message behavior is preserved
  - Add integration tests and type tests in all four framework SDKs
    verifying BaseMessage conversion

## 1.7.0

### Minor Changes

- [#2001](https://github.com/langchain-ai/langgraphjs/pull/2001) [`e051ef6`](https://github.com/langchain-ai/langgraphjs/commit/e051ef6aa8301f39badc9f496cbacef73bb4e2c4) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(react): initial first release for `@langchain/react`

## 1.6.5

### Patch Changes

- [#1984](https://github.com/langchain-ai/langgraphjs/pull/1984) [`aa8e878`](https://github.com/langchain-ai/langgraphjs/commit/aa8e878e5b71128685ab7e7a79c96bd2519c0123) Thanks [@colifran](https://github.com/colifran)! - feat: add tools stream mode for tool lifecycle events

- [#1987](https://github.com/langchain-ai/langgraphjs/pull/1987) [`1b088e5`](https://github.com/langchain-ai/langgraphjs/commit/1b088e578aaef7d231f37885b94bfd763f99a775) Thanks [@hinthornw](https://github.com/hinthornw)! - feat(sdk): add extract parameter to threads.search()

## 1.6.4

### Patch Changes

- [#1958](https://github.com/langchain-ai/langgraphjs/pull/1958) [`fc6505b`](https://github.com/langchain-ai/langgraphjs/commit/fc6505b5c380713ac769786825613f5c68ac9ea8) Thanks [@hieusmiths](https://github.com/hieusmiths)! - Export stream error class

- [#1978](https://github.com/langchain-ai/langgraphjs/pull/1978) [`d7828d0`](https://github.com/langchain-ai/langgraphjs/commit/d7828d0e1a8a05e703bf9783037b8b97a475ff10) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): resolve UseStream type incompatibility with useStream return type

- [#1977](https://github.com/langchain-ai/langgraphjs/pull/1977) [`33eb707`](https://github.com/langchain-ai/langgraphjs/commit/33eb70747b0446f109a445d14d8cfcdd8a14a93c) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): abort previous stream in useStream when using interrupt/rollback multitask strategy

## 1.6.3

### Patch Changes

- [#1972](https://github.com/langchain-ai/langgraphjs/pull/1972) [`242cfbb`](https://github.com/langchain-ai/langgraphjs/commit/242cfbbb6ab375c91bd021f64ec652840af591a9) Thanks [@rx5ad](https://github.com/rx5ad)! - add 'state_updated_at' field to threads

## 1.6.2

### Patch Changes

- [#1956](https://github.com/langchain-ai/langgraphjs/pull/1956) [`8a84c04`](https://github.com/langchain-ai/langgraphjs/commit/8a84c0448eb2db7619c43be7c6e35daa058ac613) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): make SubagentStream and SubagentToolCall generic for type-safe subagent inference

## 1.6.1

### Patch Changes

- [#1951](https://github.com/langchain-ai/langgraphjs/pull/1951) [`948aa2d`](https://github.com/langchain-ai/langgraphjs/commit/948aa2d8617398dc797e67b3f152ac6f8d7bdfd3) Thanks [@maahir30](https://github.com/maahir30)! - feat(stream): Add interrupts array to useStream for multi-interrupt support
  - Adds a new interrupts (plural) array property to the useStream hook

## 1.6.0

### Minor Changes

- [#1903](https://github.com/langchain-ai/langgraphjs/pull/1903) [`8d5c2d6`](https://github.com/langchain-ai/langgraphjs/commit/8d5c2d688d330012638d8f34ce20a454600ebc1b) Thanks [@christian-bromann](https://github.com/christian-bromann)! - feat(sdk): add multi-subagent tracking to useStream

## 1.5.6

### Patch Changes

- [#1940](https://github.com/langchain-ai/langgraphjs/pull/1940) [`d23a4db`](https://github.com/langchain-ai/langgraphjs/commit/d23a4dbcb98d0247869dcb876022d680f9c328c4) Thanks [@rx5ad](https://github.com/rx5ad)! - feat(sdk-js): add support for pausing/unpausing crons

## 1.5.5

### Patch Changes

- [#1893](https://github.com/langchain-ai/langgraphjs/pull/1893) [`98c0f26`](https://github.com/langchain-ai/langgraphjs/commit/98c0f26f4cc2c246359914704278ff5e3ae46a01) Thanks [@christian-bromann](https://github.com/christian-bromann)! - fix(sdk): infer agent types in stream.values

- [#1909](https://github.com/langchain-ai/langgraphjs/pull/1909) [`a3669be`](https://github.com/langchain-ai/langgraphjs/commit/a3669be176c5bca4b5bbcc6a6245882a684fb12f) Thanks [@dqbd](https://github.com/dqbd)! - Make sure we always pass URL as a string to fetch

## 1.5.4

### Patch Changes

- [#1821](https://github.com/langchain-ai/langgraphjs/pull/1821) [`5629d46`](https://github.com/langchain-ai/langgraphjs/commit/5629d46362509f506ab455389e600eff7d9b34bb) Thanks [@dqbd](https://github.com/dqbd)! - feat(sdk): allow client-side filtering of events when joining a stream.

- [#1897](https://github.com/langchain-ai/langgraphjs/pull/1897) [`78743d6`](https://github.com/langchain-ai/langgraphjs/commit/78743d6bca96945d574713ffefe32b04a4c04d29) Thanks [@bracesproul](https://github.com/bracesproul)! - fix: cannot convert undefined or null to object error in `useStream`

## 1.5.3

### Patch Changes

- [#1887](https://github.com/langchain-ai/langgraphjs/pull/1887) [`2eef6ed`](https://github.com/langchain-ai/langgraphjs/commit/2eef6ed3a584694c0d1c567ff6db8a70616de776) Thanks [@hinthornw](https://github.com/hinthornw)! - Made JS SSE reconnect logic match Python by retrying based on Location (even before a first event) and retry on Undici connection errors.

## 1.5.2

### Patch Changes

- [#1882](https://github.com/langchain-ai/langgraphjs/pull/1882) [`f2e24a0`](https://github.com/langchain-ai/langgraphjs/commit/f2e24a038721a378d11275cd3201948defb7f36a) Thanks [@andrewnguonly](https://github.com/andrewnguonly)! - Fix bug in UseStream export.

## 1.5.1

### Patch Changes

- [#1880](https://github.com/langchain-ai/langgraphjs/pull/1880) [`7ec00d8`](https://github.com/langchain-ai/langgraphjs/commit/7ec00d8012ea4fb7132f009ba57992eecdce1ae5) Thanks [@hntrl](https://github.com/hntrl)! - readd UseStream instance exports

## 1.5.0

### Minor Changes

- [#1845](https://github.com/langchain-ai/langgraphjs/pull/1845) [`344b2d2`](https://github.com/langchain-ai/langgraphjs/commit/344b2d2c1a6dca43e9b01e436b00bca393bc9538) Thanks [@cwlbraa](https://github.com/cwlbraa)! - Add `onRunCompleted` parameter to `CronsClient.create()` for controlling thread cleanup behavior in stateless crons. Options are `"delete"` (default) to automatically clean up threads, or `"keep"` to preserve threads for later retrieval.

### Patch Changes

- [#1874](https://github.com/langchain-ai/langgraphjs/pull/1874) [`84a636e`](https://github.com/langchain-ai/langgraphjs/commit/84a636e52f7d3a4b97ae69d050efd9ca0224c6ca) Thanks [@bracesproul](https://github.com/bracesproul)! - Expose and pass down interrupt generic type

- [#1873](https://github.com/langchain-ai/langgraphjs/pull/1873) [`2b9f3ee`](https://github.com/langchain-ai/langgraphjs/commit/2b9f3ee83d0b8ba023e7a52b938260af3f6433d4) Thanks [@andrewnguonly](https://github.com/andrewnguonly)! - Add delete_threads query parameter to delete assistants API.

## 1.4.6

### Patch Changes

- [#1862](https://github.com/langchain-ai/langgraphjs/pull/1862) [`e7aeffe`](https://github.com/langchain-ai/langgraphjs/commit/e7aeffeb72aaccd8c94f8e78708f747ce21bf23c) Thanks [@dqbd](https://github.com/dqbd)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.5

### Patch Changes

- [#1856](https://github.com/langchain-ai/langgraphjs/pull/1856) [`a9fa28b`](https://github.com/langchain-ai/langgraphjs/commit/a9fa28b6adad16050fcf5d5876a3924253664217) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.4

### Patch Changes

- [#1853](https://github.com/langchain-ai/langgraphjs/pull/1853) [`a84c1ff`](https://github.com/langchain-ai/langgraphjs/commit/a84c1ff18289653ff4715bd0db4ac3d06600556e) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.3

### Patch Changes

- [#1850](https://github.com/langchain-ai/langgraphjs/pull/1850) [`e9f7e8e`](https://github.com/langchain-ai/langgraphjs/commit/e9f7e8e9e6b8851cb7dd68e31d2f1867b62bd6bd) Thanks [@christian-bromann](https://github.com/christian-bromann)! - retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.2

### Patch Changes

- 3ec85a4: retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.1

### Patch Changes

- 3613386: retry release: add type-safe tool call streaming with agent type inference, provide proper error message when failing to connect to a server, expose Thread["config"] and Thread["error"]

## 1.4.0

### Minor Changes

- 730dc7c: feat(sdk): add type-safe tool call streaming with agent type inference

### Patch Changes

- 730dc7c: fix(sdk): provide proper error message when failing to connect to a server
- 4ffdde9: Expose `Thread["config"]` and `Thread["error"]`

## 1.3.1

### Patch Changes

- 58aa2cf: Adding retry support for stream methods on network issues

## 1.3.0

### Minor Changes

- 1497df9: feat(sdk): add support for enqueuing `useStream().submit(...)` calls while the agent is still running

## 1.2.0

### Minor Changes

- 379de5e: Fix tool calls arguments not being streamed to the client

### Patch Changes

- d08e484: Add support for sending `AbortSignal` to all SDK methods
- d08e484: Fix `useStream().stop()` not cancelling creation of thread.

## 1.1.0

### Minor Changes

- e19e76c: Rename `experimental_thread` to `thread`, allowing replacing built-in history fetching hook with React Query / SWR
- fa6c009: Add throttle option to `useStream` and batch updates in a macrotask to prevent `Maximum update depth exceeded` error

### Patch Changes

- 35e8fc7: Add name parameter to assistants count API.
- b78a738: feat(sdk): add `includePagination` property when searching from assistants

## 1.0.3

### Patch Changes

- 5ae7552: Adding support to skip auto loading api key when set to null on sdk client create

## 1.0.2

### Patch Changes

- 1f6efc5: Ensure `isLoading` is set to `false` when cancelling the stream due to thread ID change

## 1.0.1

### Patch Changes

- b9be526: Adding functionality to search assistants by name in the in-memory server implementation.
- cc9dc28: Add `values` parameter to thread search

## 1.0.0

### Major Changes

- 1e1ecbb: This release updates the package for compatibility with LangGraph v1.0. See the [v1.0 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) for details on what's new.

## 0.1.10

### Patch Changes

- 47cdce7: Fix stale values being received by optimistic values callback in `stream.submit(...)`

## 0.1.9

### Patch Changes

- 02beb41: Add support for creating stateless runs

## 0.1.8

### Patch Changes

- 90dcb8b: Add support for managing thread state manually outside of useStream hook via `experimental_thread` option

## 0.1.7

### Patch Changes

- bbc90e6: Fix thread history state being kept stale when changing `thread_id`

## 0.1.6

### Patch Changes

- 5603276: Fix `useStream()` keeping stale thread history when switching threads mid-stream (#1632)
- b65c80b: Add `transport` option to useStream, allowing custom endpoints, that emit compatible Server-Sent Events to be used with `useStream`.
- 5603276: Fix `stop()` behavior when cancelling a resumable stream via `useStream()` (#1610)

## 0.1.5

### Patch Changes

- f21fd04: Fix mutate function in `onCustomEvent` and in `onUpdateEvent` receiving incorrect previous value

## 0.1.4

### Patch Changes

- 599a8c5: Add support for streaming of RemoveMessage in useStream
- 15afabe: Allow `@langchain/core@1.0.0-alpha` installed alongside SDK

## 0.1.3

### Patch Changes

- ba7682f: Add TTL support to ThreadsClient in TypeScript to match Python SDK:

  - `threads.create({ ttl })` now accepts either a number (minutes) or an object `{ ttl: number, strategy?: "delete" }`.
  - `threads.update(threadId, { ttl })` accepts the same forms.

  Numeric TTL values are normalized to `{ ttl, strategy: "delete" }` in the request payload.

## 0.1.2

### Patch Changes

- 3b1e137: Add `description` field for assistants auth handlers

## 0.1.1

### Patch Changes

- 7de6680: Fix `onRequest` not being called when streaming runs or threads (#1585)
- df8b662: Fix interrupts not being exposed in `useStream["interrupt"]` when `fetchStateHistory: false`
- 572de43: feat(threads): add `ids` filter to Threads.search

  - SDK: `ThreadsClient.search` now accepts `ids?: string[]` and forwards it to `/threads/search`.
  - API: `/threads/search` schema accepts `ids` and storage filters by provided thread IDs.

  This enables fetching a specific set of threads directly via the search endpoint, while remaining backward compatible.

## 0.1.0

### Minor Changes

- 35a0f1c: feat(sdk): set default limit of fetch history to 10
- 35a0f1c: feat(sdk): set default of `fetchStateHistory` to `false`

### Patch Changes

- 35a0f1c: chore(sdk): decouple stream manager from React
- 35a0f1c: fix(sdk): prevent partial history from hiding all values

## 0.0.112

### Patch Changes

- a50e02e: feat(sdk): add thread streaming endpoint
- 7e210a1: feat(sdk): add durability param to run methods
- 5766b62: Fix `isThreadLoading: false` when initially mounting in useStream

## 0.0.111

### Patch Changes

- b5f14d0: Add methods to connect with the /count endpoints

## 0.0.109

### Patch Changes

- e8b4540: Add support for select statements in the search endpoints
- 9c57526: fix(sdk): expose subgraph events in useStream callbacks

## 0.0.107

### Patch Changes

- 72386a4: feat(sdk): expose stream metadata from messages via `getMessagesMetadata`
- 3ee5c20: fix(sdk): avoid setting `messages-tuple` if only `getMessagesMetadata` is requested.

## 0.0.106

### Patch Changes

- feat(sdk): allow setting `checkpoint: null` when submitting a run via useStream

## 0.0.105

### Patch Changes

- 7054a6a: add context to assistantBase interface

## 0.0.104

### Patch Changes

- af9ec5a: feat(sdk): add `isThreadLoading` option to `useStream`, handle thread error fetching
- 8e1ec9e: feat(sdk): add Context API support for useStream
- f43e48c: fix(sdk): handle subgraph custom events in stream processing of useStream

## 0.0.103

### Patch Changes

- f1bcec7: Add support for context API

## 0.0.102

### Patch Changes

- 030698f: feat(api): add support for injecting `langgraph_node` in structured logs, expose structlog

## 0.0.101

### Patch Changes

- f5e87cb: fix(sdk): allow async authorize callback

## 0.0.100

### Patch Changes

- a0efb98: Rename `interrupt_id` to `id`

## 0.0.99

### Patch Changes

- 768e2e2: feat(sdk): expose interrupt_id in types

## 0.0.98

### Patch Changes

- ee1defa: feat(sdk): add typing for "tasks" and "checkpoints" stream mode

## 0.0.97

### Patch Changes

- ac7b067: fix(sdk): use `kind` when checking for Studio user

## 0.0.96

### Patch Changes

- 53b8c30: fix(sdk): `runs.join()` returns the thread values

## 0.0.95

### Patch Changes

- 39cc88f: useStream should receive and merge messages from subgraphs
- c1ddda1: Fix fetching state with `fetchStateHistory: false` causing crash if thread is empty

## 0.0.94

### Patch Changes

- 11e95e0: Add isStudioUser for custom auth

## 0.0.93

### Patch Changes

- d53c891: Fix useStream race condition when flushing messages

## 0.0.92

### Patch Changes

- 603daa6: Make history fetching configurable in useStream via `fetchStateHistory`

## 0.0.91

### Patch Changes

- 2f26f2f: Send metadata when creating a new thread

## 0.0.90

### Patch Changes

- c8d7a0a: Add missing optional peer dependency on react-dom

/**
 * Where 2.0 behaves differently from 1.x on purpose. Each entry quotes the
 * line of `docs/v2-migration.md` that tells users, and the scenarios that
 * hit it check each side's own behavior instead of comparing the two.
 *
 * `guide: null` marks a difference no line of the guide covers yet: it waits
 * for a decision to fix 2.0 or to document it, and fails `differences.test`.
 */
export const DIFFERENCES = {
  submitDuringRunWaits: {
    guide: "### A message sent during a run waits",
    v1: "a submit during a run asks the server to interrupt it",
    v2: "a submit during a run waits in the queue",
  },
  serverQueue: {
    guide: "### The queue lives on the server",
    v1: "queued submits wait in the page",
    v2: "queued submits are runs in the server's queue",
  },
  threadCreatedFirst: {
    guide: "### New threads are created before their first run",
    v1: "the first submit makes the thread id in the browser",
    v2: "the first submit sends POST /threads, then the run",
  },
  onThreadIdOnEveryChange: {
    guide: "### `onThreadId` fires on every thread change",
    v1: "onThreadId fires for a new thread only",
    v2: "onThreadId also fires when the stream moves to another thread",
  },
  fetch: {
    guide: "### `fetch`",
    v1: "fetch carries the stream only",
    v2: "fetch carries every request, and is ignored with a passed client",
  },
  stopCancelsAnyShownRun: {
    guide: "### `stop()` also cancels runs this page didn't start",
    v1: "stop() cancels only a run this page started",
    v2: "stop() cancels the run the page shows",
  },
  lateAnswerFails: {
    guide: "### A late answer fails",
    v1: "an answer to an interrupt no longer waiting starts no run: the Agent Server rejects it and respond() fails, the JS dev server ignores it",
    v2: "it fails its run, on a server with strict resume",
  },
  respondWithoutId: {
    guide: "### `respond()` with no id answers `interrupt`",
    v1: "respond() answers the newest unanswered interrupt",
    v2: "respond() answers the interrupt `stream.interrupt` shows",
  },
  errorAfterLoad: {
    guide: "### `error` shows the thread's last error after a load",
    v1: "error holds only this page's errors",
    v2: "error also shows the thread's last error after a load",
  },
  suspenseThrowsLoadOnly: {
    guide: "### `useSuspenseStream` throws only a failed load",
    v1: "any error with no run streaming reaches the error boundary",
    v2: "only a failed thread load reaches the error boundary",
  },
  valuesMessagesStream: {
    guide: "### `values.messages` streams token by token",
    v1: "values[messagesKey] changes once per step",
    v2: "values[messagesKey] streams like messages",
  },
  forkPointsAfterRun: {
    guide: "### Fork points arrive after a run",
    v1: "every reloaded message gets the head's parent",
    v2: "fork points are read when a run ends or a thread loads",
  },
  subgraphsAfterReload: {
    guide: "### Subgraphs after a reload",
    v1: "subgraphs are rebuilt from history on load",
    v2: "subgraphs start empty after a reload",
  },
  runsStartedElsewhere: {
    guide: "### Runs started elsewhere",
    v1: "a thread follows runs from elsewhere once it is active",
    v2: "every loaded thread follows runs from elsewhere",
  },
  channelHooksStartAtMount: {
    guide: "### Channel hooks start when they mount",
    v1: "useChannel replays the run's earlier events",
    v2: "channel hooks get events from when they mount",
  },
  channelEvents: {
    guide: "### Channel events",
    v1: "content-block events on `messages`",
    v2: "[chunk, metadata] pairs on `messages`",
  },
  customWrapsEveryWrite: {
    guide: "Every event a graph writes arrives on the `custom` channel as `{ payload: <what it wrote> }`.",
    v1: "with a JS graph, a write shaped `{ name, payload }` arrives as it is",
    v2: "every write arrives as `{ payload: <what it wrote> }`",
  },
  submitOptionsReachServer: {
    guide: "### `interruptBefore` and `interruptAfter` take effect",
    v1: "submit() drops command, interruptBefore and interruptAfter",
    v2: "submit() sends them",
  },
  callbacksFromLatestRender: {
    guide: "are read from the latest render, so they see current state",
    v1: "callbacks of the first render",
    v2: "callbacks of the latest render",
  },
  stableFunctions: {
    guide: "keep their identity across renders",
    v1: "new functions on every update",
    v2: "the same functions across renders",
  },
  inlineHeadersKeepClient: {
    guide: "`defaultHeaders` and `callerOptions` are compared by entry",
    v1: "inline defaultHeaders build a new client on every render",
    v2: "inline defaultHeaders keep the client while their values stay",
  },
  threadOnErrorOnRunErrors: {
    guide: '### `getThread().onError` also fires for failed runs',
    v1: "getThread().onError fires for stream failures only: a server error frame, or reconnects given up",
    v2: "it also fires when a run fails",
  },
  valuesOnlyFromGraph: {
    guide: "### `values` has only the graph's keys",
    v1: "values gets an empty `messages` key when the graph has none",
    v2: "values holds only the graph's own keys",
  },
  joinedRunCompletedWithId: {
    guide: '`onCompleted` gets the `runId` of a run the hook joined',
    v1: "onCompleted for a run the hook joined carries no runId",
    v2: "it carries the run's id",
  },
  subagentOutputIsText: {
    guide: "### A subagent's `output` is its text",
    v1: "a finished subagent's output is its tool message, as an object",
    v2: "it is the tool message's text",
  },
  quietSameThreadHydrate: {
    guide: 'Reading the current one again leaves `isThreadLoading` `false`',
    v1: "hydrate() on the shown thread sets isThreadLoading while it reads",
    v2: "it reads again without isThreadLoading, keeping the thread on screen",
  },
  subagentNamespaceFoundOnUse: {
    guide: "### A subagent's `namespace` after a reload",
    v1: "after a reload, each subagent shows its own namespace and depth",
    v2: "after a reload, a subagent's namespace is the one its task tool message records, else [`tools:<tool call id>`] until a hook looks it up, and its depth is right either way",
  },
  rootChannelsIncludeSubagents: {
    guide: 'and, with a Python graph, their `messages` and `tools` events too',
    v1: "a channel hook on the main conversation also gets its direct subgraphs' and subagents' values, updates and custom events, and with a Python graph their messages and tools events",
    v2: "it gets the main agent's events, plus the lifecycle events one level down",
  },
  nestedNamespaceAfterLoad: {
    guide: "### A nested interrupt's `namespace` after a load",
    v1: "a nested interrupt in getThread().interrupts names its whole namespace after a load",
    v2: "after a load it names only the top subgraph, the task's checkpoint namespace (live runs give the whole one)",
  },
  streamedContentIsString: {
    guide: "### A streaming message's `content` is the server's",
    v1: "a streamed AI message's content is an array of content blocks, and a model called inside a node of 1.x's run can return them to the graph",
    v2: "it is a string, as the server stores it and as 1.x shows after a reload, and graph code sees a string",
  },
} as const satisfies Record<string, { guide: string | null; v1: string; v2: string }>;

export type Difference = keyof typeof DIFFERENCES;

/** An assertion message naming the difference a per-side check covers. */
export const is = (difference: Difference) => `differs by design: ${difference}`;

/**
 * 1.x bugs the scenarios found. Where 1.x is wrong, a scenario checks that
 * 2.0 is right, and checks 1.x only where its bug always shows.
 */
export const V1_BUGS = {
  stoppedRunReadsAsInterrupt:
    "onCompleted reports a stopped run as \"interrupt\": always on the JS dev server, sometimes on the Agent Server",
  earlyStopDoesNotCancel:
    "a stop before the run's id arrives leaves the run going, and onCompleted may come twice",
  answerRunsUntracked:
    "a run that respond() starts can get no onCreated, onCompleted or isLoading",
  answerRunNotStopped:
    "on the JS dev server, stop() right after respond() can leave the answer's run going, and then no card shows",
  interruptLetsRunFinish:
    "a submit during a run asks the server to interrupt it, but its run starts only once the running one ends: the JS dev server's protocol routes queue it, and the Python server holds it until then",
  rootToolCallsListSubagents:
    "on the Python server, the main conversation's toolCalls also list the subagents' tool calls",
  commandOutputShownRaw:
    "on an Agent Server, a tool that returns a Command shows the Command as its output, and a subagent panel can show an empty tool message for it",
  waitingToolNeverAnswered:
    "on the JS dev server, a headless tool waiting on a thread the hook opens runs, but its result fails to send (\"Thread has no active assistant\")",
  failedSubmitShowsNoStatus:
    "on the JS dev server, a message whose run fails to start ends with no optimistic status, not failed",
  forkLoadingFlickers:
    "a fork submitted right after a run shows isLoading false for a moment between its input and its run",
  initialMessagesStay:
    "a loaded thread, or a run on a new thread, shows the initialValues' messages after its own, where its state should replace them",
  plainSubmitWhileWaitingLost:
    "a plain submit while approvals wait starts no run, and the approvals disappear from the page",
  pausedThreadBlinksLoading:
    "opening a thread paused at an approval shows isLoading for a moment and calls onCompleted(\"interrupt\"), with no run going",
  secondHookMissesRunningRun:
    "a hook mounted, or hydrated, on a thread while a run streams there sometimes shows neither the run nor its answer: it takes the thread for idle from a checkpoint that can trail the stream",
  stopBlinksLoading: "after stop(), isLoading can turn true for a moment once more",
  panelShowsToolFirst:
    "on the Python server, a subagent panel opened mid-run can first show the subagent's tool message alone, before its earlier messages",
} as const;

export type V1Bug = keyof typeof V1_BUGS;

/** An assertion message naming the 1.x bug a per-side check covers. */
export const v1Bug = (bug: V1Bug) => `1.x bug: ${bug}`;

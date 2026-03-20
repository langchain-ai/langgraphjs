# @langchain/react

React SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview). It provides a `useStream` hook that manages streaming, state, branching, and interrupts out of the box.

## Installation

```bash
npm install @langchain/react @langchain/core
```

**Peer dependencies:** `react` (^18 || ^19), `@langchain/core` (^1.1.27)

## Quick Start

```tsx
import { useStream } from "@langchain/react";

function Chat() {
  const { messages, submit, isLoading } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={msg.id ?? i}>{msg.content}</div>
      ))}

      <button
        disabled={isLoading}
        onClick={() =>
          void submit({
            messages: [{ type: "human", content: "Hello!" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
```

## `useStream` Options

| Option | Type | Description |
|---|---|---|
| `assistantId` | `string` | **Required.** The assistant/graph ID to stream from. |
| `apiUrl` | `string` | Base URL of the LangGraph API. |
| `client` | `Client` | Pre-configured `Client` instance (alternative to `apiUrl`). |
| `messagesKey` | `string` | State key containing messages. Defaults to `"messages"`. |
| `initialValues` | `StateType` | Initial state values before any stream data arrives. |
| `fetchStateHistory` | `boolean \| { limit: number }` | Fetch thread history on stream completion. Enables branching. |
| `throttle` | `boolean \| number` | Throttle state updates for performance. |
| `onFinish` | `(state, error?) => void` | Called when the stream completes. |
| `onError` | `(error, state?) => void` | Called on stream errors. |
| `onThreadId` | `(threadId) => void` | Called when a new thread is created. |
| `onUpdateEvent` | `(event) => void` | Receive update events from the stream. |
| `onCustomEvent` | `(event) => void` | Receive custom events from the stream. |
| `onStop` | `() => void` | Called when the stream is stopped by the user. |

## Return Values

| Property | Type | Description |
|---|---|---|
| `values` | `StateType` | Current graph state. |
| `messages` | `Message[]` | Messages from the current state. |
| `isLoading` | `boolean` | Whether a stream is currently active. |
| `error` | `unknown` | The most recent error, if any. |
| `interrupt` | `Interrupt \| undefined` | Current interrupt requiring user input. |
| `branch` | `string` | Active branch identifier. |
| `submit(values, options?)` | `function` | Submit new input to the graph. When called while a stream is active, the run is created on the server with `multitaskStrategy: "enqueue"` and queued automatically. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |
| `switchThread(id)` | `(id: string \| null) => void` | Switch to a different thread. Pass `null` to start a new thread on next submit. |
| `queue.entries` | `ReadonlyArray<QueueEntry>` | Pending server-side runs. Each entry has `id` (server run ID), `values`, `options`, and `createdAt`. |
| `queue.size` | `number` | Number of pending runs on the server. |
| `queue.cancel(id)` | `(id: string) => Promise<boolean>` | Cancel a pending run on the server by its run ID. |
| `queue.clear()` | `() => Promise<void>` | Cancel all pending runs on the server. |

## `useSuspenseStream`

`useSuspenseStream` is a companion hook to `useStream` that integrates with React's [Suspense](https://react.dev/reference/react/Suspense) and [Error Boundary](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary) protocols. Instead of handling loading and error states inside your component, you declare them in parent boundaries:

```tsx
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useSuspenseStream } from "@langchain/react";

function App() {
  return (
    <ErrorBoundary
      fallback={({ error, resetErrorBoundary }) => (
        <div>
          <p>{error.message}</p>
          <button onClick={resetErrorBoundary}>Retry</button>
        </div>
      )}
    >
      <Suspense fallback={<Spinner />}>
        <Chat />
      </Suspense>
    </ErrorBoundary>
  );
}

function Chat() {
  // No isLoading/error checks needed — Suspense and ErrorBoundary handle them.
  const { messages, submit, isStreaming } = useSuspenseStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={msg.id ?? i}>{msg.content}</div>
      ))}
      {isStreaming && <TypingIndicator />}

      <button
        onClick={() =>
          void submit({
            messages: [{ type: "human", content: "Hello!" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
```

### How it works

- **Suspends** while the initial thread history is loading (e.g. when a `threadId` is provided and the thread data is being fetched). The nearest `<Suspense>` boundary renders its fallback during this time.
- **Throws errors** to the nearest Error Boundary when the stream encounters an error outside of active streaming.
- **Does not suspend during streaming.** Streaming is incremental — messages arrive progressively and the UI must update in real time. The `isStreaming` flag indicates whether tokens are currently arriving.

### Options

`useSuspenseStream` accepts the same options as `useStream` (LangGraph Platform mode), plus:

| Option | Type | Description |
|---|---|---|
| `suspenseCache` | `SuspenseCache` | Optional cache instance for Suspense history prefetching. Useful in tests to avoid cross-test cache sharing. |

### Return Values

The return type is identical to `useStream` except:

| Removed | Reason |
|---|---|
| `isLoading` | Replaced by `isStreaming`; initial loading is handled by Suspense. |
| `error` | Thrown to the nearest Error Boundary instead. |
| `isThreadLoading` | Handled by Suspense (the component suspends until the thread is ready). |

| Added | Type | Description |
|---|---|---|
| `isStreaming` | `boolean` | `true` while the stream is receiving data. The component is never suspended during streaming. |

All other properties (`messages`, `submit`, `stop`, `interrupt`, `branch`, `switchThread`, `queue`, etc.) are unchanged.

### Thread-switching with Suspense

`useSuspenseStream` works naturally with thread switching. When the `threadId` changes, the component suspends while the new thread's history loads, and `<Suspense>` shows a smooth skeleton/fallback transition:

```tsx
function App() {
  const [threadId, setThreadId] = useState<string | null>(null);

  return (
    <div className="flex">
      <ThreadSidebar onSelect={setThreadId} />

      <Suspense fallback={<ThreadSkeleton />}>
        <ChatPanel threadId={threadId} />
      </Suspense>
    </div>
  );
}

function ChatPanel({ threadId }: { threadId: string | null }) {
  const { messages, submit, isStreaming } = useSuspenseStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    threadId,
  });

  return <MessageList messages={messages} />;
}
```

### Error recovery

When an error is thrown to an Error Boundary, call `invalidateSuspenseCache()` in the boundary's reset handler so the retry triggers a fresh data fetch:

```tsx
import { invalidateSuspenseCache } from "@langchain/react";

<ErrorBoundary
  onReset={() => invalidateSuspenseCache()}
  fallbackRender={({ error, resetErrorBoundary }) => (
    <div>
      <p>{error.message}</p>
      <button onClick={resetErrorBoundary}>Retry</button>
    </div>
  )}
>
  <Suspense fallback={<Spinner />}>
    <Chat />
  </Suspense>
</ErrorBoundary>
```

For test isolation, you can create and pass a dedicated cache instance:

```tsx
import { createSuspenseCache, useSuspenseStream } from "@langchain/react";

const suspenseCache = createSuspenseCache();

function Chat() {
  const stream = useSuspenseStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    suspenseCache,
  });
  // ...
}
```

## Type Safety

### With `createAgent`

When using `createAgent`, pass `typeof agent` to automatically infer tool call types:

```tsx
import type { agent } from "./agent";

function Chat() {
  const stream = useStream<typeof agent>({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  // stream.messages, tool calls, etc. are fully typed
}
```

### With `StateGraph`

For custom graphs, provide your state type directly:

```tsx
import type { BaseMessage } from "langchain";

interface MyState {
  messages: BaseMessage[];
  context?: string;
}

function Chat() {
  const { messages, submit } = useStream<MyState>({
    assistantId: "my-graph",
    apiUrl: "http://localhost:2024",
  });
}
```

### Typed Interrupts

Pass interrupt types via the second generic parameter:

```tsx
const { interrupt, submit } = useStream<
  MyState,
  { InterruptType: { question: string } }
>({
  assistantId: "my-graph",
  apiUrl: "http://localhost:2024",
});

if (interrupt) {
  // interrupt.value is typed as { question: string }
}
```

## Handling Interrupts

Interrupts let you pause graph execution and wait for user input:

```tsx
function Chat() {
  const { messages, interrupt, submit } = useStream<
    { messages: BaseMessage[] },
    { InterruptType: { question: string } }
  >({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={msg.id ?? i}>{msg.content}</div>
      ))}

      {interrupt && (
        <div>
          <p>{interrupt.value.question}</p>
          <button
            onClick={() =>
              void submit(null, { command: { resume: "Approved" } })
            }
          >
            Approve
          </button>
        </div>
      )}

      <button
        onClick={() =>
          void submit({
            messages: [{ type: "human", content: "Hello" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
```

## Branching

Enable conversation branching by setting `fetchStateHistory: true`:

```tsx
function Chat() {
  const { messages, submit, getMessagesMetadata, setBranch } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    fetchStateHistory: true,
  });

  return (
    <div>
      {messages.map((msg, i) => {
        const metadata = getMessagesMetadata(msg, i);
        const branchOptions = metadata?.branchOptions;
        const branch = metadata?.branch;

        return (
          <div key={msg.id ?? i}>
            <p>{msg.content}</p>
            {branchOptions && branch && (
              <div>
                <button onClick={() => {
                  const prev = branchOptions[branchOptions.indexOf(branch) - 1];
                  if (prev) setBranch(prev);
                }}>
                  Previous
                </button>
                <button onClick={() => {
                  const next = branchOptions[branchOptions.indexOf(branch) + 1];
                  if (next) setBranch(next);
                }}>
                  Next
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

## Server-Side Queuing

When `submit()` is called while a stream is already active, the SDK automatically creates the run on the server with `multitaskStrategy: "enqueue"`. The pending runs are tracked in `queue` and processed in order as each finishes:

```tsx
function Chat() {
  const { messages, submit, isLoading, queue, switchThread } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={msg.id ?? i}>{msg.content}</div>
      ))}

      {queue.size > 0 && (
        <div>
          <p>{queue.size} message(s) queued</p>
          <button onClick={() => void queue.clear()}>Clear Queue</button>
        </div>
      )}

      <button
        disabled={isLoading}
        onClick={() =>
          void submit({
            messages: [{ type: "human", content: "Hello!" }],
          })
        }
      >
        Send
      </button>
      <button onClick={() => switchThread(null)}>New Thread</button>
    </div>
  );
}
```

Switching threads via `switchThread()` cancels all pending runs and clears the queue.

## Custom Transport

Instead of connecting to a LangGraph API, you can provide your own streaming transport. Pass a `transport` object instead of `assistantId` to use a custom backend:

```tsx
import { useStream, FetchStreamTransport } from "@langchain/react";
import type { BaseMessage } from "langchain";

function Chat() {
  const {
    messages,
    submit,
    isLoading,
    branch,
    setBranch,
    getMessagesMetadata,
  } = useStream<{ messages: BaseMessage[] }>({
    transport: new FetchStreamTransport({
      url: "https://my-api.example.com/stream",
    }),
    threadId: null,
    onThreadId: (id) => console.log("Thread created:", id),
  });

  return (
    <div>
      {messages.map((msg, i) => {
        const metadata = getMessagesMetadata(msg, i);
        return (
          <div key={msg.id ?? i}>
            <p>{msg.content}</p>
            {metadata?.streamMetadata && (
              <span>Node: {metadata.streamMetadata.langgraph_node}</span>
            )}
          </div>
        );
      })}

      <p>Current branch: {branch}</p>

      <button
        disabled={isLoading}
        onClick={() =>
          void submit({
            messages: [{ type: "human", content: "Hello!" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
```

The custom transport interface returns the same properties as the standard `useStream` hook, including `getMessagesMetadata`, `branch`, `setBranch`, `switchThread`, and all message/interrupt/subagent helpers. When using a custom transport, `getMessagesMetadata` returns stream metadata sent alongside messages during streaming; `branch` and `setBranch` provide local branch state management. `onFinish` is also supported and receives a synthetic `ThreadState` built from the final locally streamed values; the run metadata argument is `undefined`.

## Sharing State with `StreamProvider`

When multiple components in a tree need access to the same stream (a message list, a header with loading status, an input bar), use `StreamProvider` and `useStreamContext` to avoid prop drilling:

```tsx
import { StreamProvider, useStreamContext } from "@langchain/react";

function App() {
  return (
    <StreamProvider assistantId="agent" apiUrl="http://localhost:2024">
      <ChatHeader />
      <MessageList />
      <MessageInput />
    </StreamProvider>
  );
}

function ChatHeader() {
  const { isLoading, error } = useStreamContext();
  return (
    <header>
      <h1>Chat</h1>
      {isLoading && <span>Thinking...</span>}
      {error != null && <span>Error occurred</span>}
    </header>
  );
}

function MessageList() {
  const { messages, getMessagesMetadata } = useStreamContext();
  return (
    <div>
      {messages.map((msg, i) => (
        <div key={msg.id ?? i}>{msg.content}</div>
      ))}
    </div>
  );
}

function MessageInput() {
  const { submit, isLoading } = useStreamContext();
  return (
    <button
      disabled={isLoading}
      onClick={() =>
        void submit({
          messages: [{ type: "human", content: "Hello!" }],
        })
      }
    >
      Send
    </button>
  );
}
```

### Type Safety with `StreamProvider`

Pass agent or state types to both `StreamProvider` and `useStreamContext`:

```tsx
import type { agent } from "./agent";

function App() {
  return (
    <StreamProvider<typeof agent>
      assistantId="agent"
      apiUrl="http://localhost:2024"
    >
      <Chat />
    </StreamProvider>
  );
}

function Chat() {
  const { toolCalls } = useStreamContext<typeof agent>();
  // toolCalls are fully typed from the agent's tools
}
```

### Multiple Agents

Nest providers for multi-agent scenarios — each subtree gets its own isolated stream:

```tsx
function MultiAgentApp() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
      <StreamProvider assistantId="researcher" apiUrl="http://localhost:2024">
        <ResearchPanel />
      </StreamProvider>
      <StreamProvider assistantId="writer" apiUrl="http://localhost:2024">
        <WriterPanel />
      </StreamProvider>
    </div>
  );
}
```

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT

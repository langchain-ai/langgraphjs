# @langchain/react

React SDK for building AI-powered applications with [LangChain](https://js.langchain.com/) and [LangGraph](https://langchain-ai.github.io/langgraphjs/). Provides a `useStream` hook that manages streaming, state, branching, and interrupts out of the box.

## Installation

```bash
npm install @langchain/react @langchain/core
```

**Peer dependencies:** `react` (^18 || ^19), `react-dom` (^18 || ^19), `@langchain/core` (^1.0.1)

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
| `submit(values, options?)` | `function` | Submit new input to the graph. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |

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
import type { Message } from "@langchain/langgraph-sdk";

interface MyState {
  messages: Message[];
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
    { messages: Message[] },
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

## React UI (Advanced)

The `@langchain/react/react-ui` sub-package provides utilities for rendering server-defined UI components:

```tsx
import { useStreamContext, LoadExternalComponent } from "@langchain/react/react-ui";
import { uiMessageReducer } from "@langchain/react/react-ui";
import type { UIMessage } from "@langchain/react/react-ui";
```

- **`useStreamContext`** - Access the stream context from deeply nested components
- **`LoadExternalComponent`** - Render UI components defined by the server
- **`uiMessageReducer`** - Reducer for managing UI message state

A server-side helper is also available:

```tsx
import { typedUi } from "@langchain/react/react-ui/server";
```

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangGraph Playground](https://github.com/langchain-ai/langgraphjs).

## License

MIT
